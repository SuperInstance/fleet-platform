/**
 * Fleet Narrator — Overnight caption gap analysis
 *
 * Runs at 22:00 UTC nightly. Compares machine-generated captions
 * (from vocabulary.py on the boat) against captain's actual log
 * entries. Finds gaps where the machine was wrong or silent.
 *
 * Produces:
 *   - 1 narrator_report row (summary)
 *   - N caption_gaps rows (specific discrepancies)
 *   - N caption_suggestions rows (LLM-generated fixes)
 *
 * Endpoints:
 *   GET  /health              — service health
 *   GET  /reports             — list recent reports
 *   GET  /report/:date        — get specific report
 *   POST /analyze             — manually trigger analysis
 */

export interface Env {
  DB: D1Database;
  AI: Ai;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const LLM_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const MAX_SUGGESTIONS = 25;
const ALIGN_WINDOW_SEC = 30;

// Minimal stopwords for text comparison
const STOPWORDS = new Set([
  'the','a','an','is','it','to','in','on','at','and','or','but','of','for','with','was','were','been','being','have','has','had','do','does','did','will','would','could','should','may','might','must','can','this','that','these','those','i','you','he','she','we','they','them','his','her','its','our','their','my','your','what','which','who','whom','where','when','why','how','all','any','both','each','few','more','most','other','some','such','no','nor','not','only','own','same','so','than','too','very','just','now'
]);

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (path === '/health') {
        const count = await env.DB.prepare(
          'SELECT COUNT(*) as cnt FROM narrator_reports'
        ).first() as any;
        return json({
          ok: true,
          service: 'fleet-narrator',
          schedule: '0 22 * * * UTC',
          total_reports: count?.cnt || 0,
        });
      }

      if (path === '/reports') {
        const limit = Math.min(30, parseInt(url.searchParams.get('limit') || '10'));
        const rows = await env.DB.prepare(
          'SELECT * FROM narrator_reports ORDER BY date DESC LIMIT ?'
        ).bind(limit).all();
        return json({ reports: rows.results });
      }

      const reportMatch = path.match(/^\/report\/(\d{4}-\d{2}-\d{2})$/);
      if (reportMatch && method === 'GET') {
        const date = reportMatch[1];
        const report = await env.DB.prepare(
          'SELECT * FROM narrator_reports WHERE date = ?'
        ).bind(date).first();
        if (!report) return json({ error: 'No report for ' + date }, 404);

        const gaps = await env.DB.prepare(
          'SELECT * FROM caption_gaps WHERE report_date = ? ORDER BY severity DESC'
        ).bind(date).all();
        const suggestions = await env.DB.prepare(
          'SELECT * FROM caption_suggestions WHERE report_date = ? ORDER BY confidence DESC LIMIT 25'
        ).bind(date).all();

        return json({ report, gaps: gaps.results, suggestions: suggestions.results });
      }

      if (path === '/analyze' && method === 'POST') {
        const date = url.searchParams.get('date') || todayUTC();
        const result = await runAnalysis(env, date);
        return json(result);
      }

      return json({ error: 'Not found', path }, 404);
    } catch (err: any) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const date = todayUTC();
    ctx.waitUntil(runAnalysis(env, date));
  },
};

// ═══════════════════════════════════════════════════════════════
// Core analysis
// ═══════════════════════════════════════════════════════════════

async function runAnalysis(env: Env, date: string) {
  const dayStart = `${date}T00:00:00Z`;
  const dayEnd = `${date}T23:59:59Z`;

  // Ensure narrator tables exist
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS narrator_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      total_captures INTEGER DEFAULT 0,
      total_labels INTEGER DEFAULT 0,
      gaps_found INTEGER DEFAULT 0,
      suggestions_generated INTEGER DEFAULT 0,
      summary TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS caption_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL,
      capture_id TEXT,
      machine_caption TEXT,
      captain_text TEXT,
      alignment_score REAL,
      severity TEXT,
      gap_type TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS caption_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL,
      capture_id TEXT,
      suggested_caption TEXT,
      confidence REAL,
      rationale TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Fetch captures with vocabulary predictions
  const captures = await env.DB.prepare(
    `SELECT capture_id, ts_utc, vocabulary_species, vocabulary_confidence, caption
     FROM captures WHERE ts_utc BETWEEN ? AND ?
     AND vocabulary_species IS NOT NULL
     ORDER BY ts_utc ASC LIMIT 500`
  ).bind(dayStart, dayEnd).all();

  // Fetch captain labels (training labels / catch labels)
  const labels = await env.DB.prepare(
    `SELECT capture_id, species, captain_text, timestamp
     FROM training_labels
     WHERE timestamp BETWEEN ? AND ?
     ORDER BY timestamp ASC LIMIT 500`
  ).bind(dayStart, dayEnd).all();

  if (!captures.results?.length && !labels.results?.length) {
    // Nothing to analyze — write empty report
    await env.DB.prepare(
      `INSERT OR REPLACE INTO narrator_reports (date, total_captures, total_labels, gaps_found, suggestions_generated, summary)
       VALUES (?, 0, 0, 0, 0, ?)`
    ).bind(date, `No data for ${date}.`).run();

    return { date, message: 'No data to analyze', gaps: 0 };
  }

  // Align captures with labels by timestamp proximity
  const aligned: Array<{
    capture_id: string;
    machine_caption: string;
    captain_text: string;
    machine_species: string;
    captain_species: string;
    confidence: number;
  }> = [];

  for (const cap of captures.results as any[]) {
    const capTime = new Date(cap.ts_utc).getTime() / 1000;
    let bestLabel: any = null;
    let bestDiff = Infinity;

    for (const label of labels.results as any[]) {
      const labelTime = new Date(label.timestamp).getTime() / 1000;
      const diff = Math.abs(labelTime - capTime);
      if (diff < bestDiff && diff < ALIGN_WINDOW_SEC) {
        bestDiff = diff;
        bestLabel = label;
      }
    }

    if (bestLabel) {
      aligned.push({
        capture_id: cap.capture_id,
        machine_caption: cap.caption || cap.vocabulary_species || '',
        captain_text: bestLabel.captain_text || bestLabel.species || '',
        machine_species: cap.vocabulary_species || '',
        captain_species: bestLabel.species || '',
        confidence: cap.vocabulary_confidence || 0,
      });
    }
  }

  // Find gaps: where machine and captain disagree
  const gaps: Array<any> = [];
  const suggestions: Array<any> = [];

  for (const pair of aligned) {
    // Exact species mismatch
    const speciesMismatch =
      pair.machine_species && pair.captain_species &&
      pair.machine_species !== pair.captain_species &&
      pair.machine_species !== 'unknown';

    // Text similarity (token overlap as fast proxy)
    const machineTokens = new Set(tokenize(pair.machine_caption));
    const captainTokens = new Set(tokenize(pair.captain_text));
    const intersection = [...machineTokens].filter(t => captainTokens.has(t)).length;
    const union = machineTokens.size + captainTokens.size - intersection;
    const jaccard = union > 0 ? intersection / union : 1;

    const isGap = speciesMismatch || jaccard < 0.3;
    const severity = speciesMismatch ? 'high' : jaccard < 0.15 ? 'medium' : 'low';

    if (isGap) {
      gaps.push({
        report_date: date,
        capture_id: pair.capture_id,
        machine_caption: pair.machine_caption,
        captain_text: pair.captain_text,
        alignment_score: jaccard,
        severity,
        gap_type: speciesMismatch ? 'species_mismatch' : 'caption_misalignment',
      });
    }
  }

  // Generate LLM suggestions for top gaps
  const topGaps = gaps
    .filter(g => g.severity !== 'low')
    .sort((a, b) => (a.alignment_score || 1) - (b.alignment_score || 1))
    .slice(0, MAX_SUGGESTIONS);

  for (const gap of topGaps) {
    try {
      const result = await env.AI.run(LLM_MODEL, {
        messages: [
          {
            role: 'system',
            content: 'You are a marine ML analyst. Given a machine caption and the captain\'s actual description, suggest a better caption. Respond in ONE sentence.',
          },
          {
            role: 'user',
            content: `Machine said: "${gap.machine_caption}"\nCaptain said: "${gap.captain_text}"\nSuggest an improved caption:`,
          },
        ],
        max_tokens: 80,
      }) as any;

      const suggestion = (result.response || '').trim();
      if (suggestion) {
        suggestions.push({
          report_date: date,
          capture_id: gap.capture_id,
          suggested_caption: suggestion,
          confidence: 1 - gap.alignment_score,
          rationale: `${gap.gap_type} (score: ${gap.alignment_score?.toFixed(2)})`,
        });
      }
    } catch {
      // LLM may fail — skip this suggestion
    }
  }

  // Write results to D1
  const summary = `Analyzed ${captures.results?.length || 0} captures with ${labels.results?.length || 0} labels. Found ${gaps.length} gaps (${gaps.filter(g => g.severity === 'high').length} high severity). Generated ${suggestions.length} suggestions.`;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO narrator_reports (date, total_captures, total_labels, gaps_found, suggestions_generated, summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    date,
    captures.results?.length || 0,
    labels.results?.length || 0,
    gaps.length,
    suggestions.length,
    summary
  ).run();

  // Batch insert gaps
  for (const gap of gaps.slice(0, 100)) {
    await env.DB.prepare(
      `INSERT INTO caption_gaps (report_date, capture_id, machine_caption, captain_text, alignment_score, severity, gap_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      gap.report_date, gap.capture_id, gap.machine_caption?.slice(0, 500),
      gap.captain_text?.slice(0, 500), gap.alignment_score, gap.severity, gap.gap_type
    ).run();
  }

  // Batch insert suggestions
  for (const sug of suggestions) {
    await env.DB.prepare(
      `INSERT INTO caption_suggestions (report_date, capture_id, suggested_caption, confidence, rationale)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      sug.report_date, sug.capture_id, sug.suggested_caption?.slice(0, 500),
      sug.confidence, sug.rationale
    ).run();
  }

  return {
    date,
    captures: captures.results?.length || 0,
    labels: labels.results?.length || 0,
    aligned: aligned.length,
    gaps: gaps.length,
    suggestions: suggestions.length,
    summary,
  };
}
