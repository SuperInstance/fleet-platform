/**
 * Fleet Vision — Cloud-side echogram analysis via Workers AI
 *
 * Runs on captures synced from the boat. For each echogram PNG:
 *   1. Classifies the image (@cf/unleash/image-classification or similar)
 *   2. Optionally detects blobs/feed patterns
 *   3. Writes results back to D1 (captures.vocabulary_species, .vocabulary_confidence)
 *   4. Flags interesting captures for the narrator
 *
 * Endpoints:
 *   POST /analyze/:captureId  — analyze a specific capture from R2
 *   POST /analyze-batch       — analyze all unanalyzed captures (cron-triggered)
 *   GET  /results/:captureId  — get vision results for a capture
 *   GET  /health              — service health
 *
 * Cron: 23:00 UTC nightly (after narrator at 22:00, before morning brief at 03:00)
 */

export interface Env {
  DB: D1Database;
  ECHOGRAMS: R2Bucket;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      // ── Health ────────────────────────────────────────────────
      if (path === '/health') {
        const count = await env.DB.prepare(
          'SELECT COUNT(*) as total, COUNT(vocabulary_species) as analyzed FROM captures'
        ).first();
        return json({
          ok: true,
          service: 'fleet-vision',
          captures: count?.total || 0,
          analyzed: count?.analyzed || 0,
        });
      }

      // ── Analyze single capture ────────────────────────────────
      const analyzeMatch = path.match(/^\/analyze\/(.+)$/);
      if (analyzeMatch && method === 'POST') {
        const captureId = analyzeMatch[1];
        const result = await analyzeCapture(env, captureId);
        return json(result);
      }

      // ── Analyze batch (cron or manual) ────────────────────────
      if (path === '/analyze-batch' && method === 'POST') {
        const limit = Math.min(50, parseInt(url.searchParams.get('limit') || '20'));
        const results = await analyzeBatch(env, limit);
        return json({ analyzed: results.length, results });
      }

      // ── Get results for a capture ─────────────────────────────
      const resultsMatch = path.match(/^\/results\/(.+)$/);
      if (resultsMatch && method === 'GET') {
        const captureId = resultsMatch[1];
        const row = await env.DB.prepare(
          'SELECT capture_id, ts_utc, vocabulary_species, vocabulary_confidence, caption, blob_count_lf, thermocline_count FROM captures WHERE capture_id = ?'
        ).bind(captureId).first();
        if (!row) return json({ error: 'Capture not found' }, 404);
        return json(row);
      }

      // ── List unanalyzed ───────────────────────────────────────
      if (path === '/pending' && method === 'GET') {
        const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50'));
        const rows = await env.DB.prepare(
          `SELECT capture_id, ts_utc FROM captures WHERE vocabulary_species IS NULL AND png_r2_key IS NOT NULL ORDER BY ts_utc DESC LIMIT ?`
        ).bind(limit).all();
        return json({ pending: rows.results?.length || 0, captures: rows.results });
      }

      return json({ error: 'Not found', path }, 404);
    } catch (err: any) {
      return json({ error: err.message }, 500);
    }
  },

  // ── Cron trigger ──────────────────────────────────────────────
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(analyzeBatch(env, 30));
  },
};

// ═══════════════════════════════════════════════════════════════
// Core analysis logic
// ═══════════════════════════════════════════════════════════════

interface AnalysisResult {
  capture_id: string;
  species?: string;
  confidence: number;
  blob_count?: number;
  feed_present?: boolean;
  caption?: string;
  error?: string;
}

async function analyzeCapture(env: Env, captureId: string): Promise<AnalysisResult> {
  // Fetch capture metadata
  const capture = await env.DB.prepare(
    'SELECT capture_id, ts_utc, png_r2_key, blob_count_lf, thermocline_count FROM captures WHERE capture_id = ?'
  ).bind(captureId).first() as any;

  if (!capture) return { capture_id: captureId, confidence: 0, error: 'Capture not found' };
  if (!capture.png_r2_key) return { capture_id: captureId, confidence: 0, error: 'No echogram PNG available' };

  // Fetch the PNG from R2
  const image = await env.ECHOGRAMS.get(capture.png_r2_key);
  if (!image) return { capture_id: captureId, confidence: 0, error: 'PNG not found in R2' };

  const imageData = await image.arrayBuffer();

  // Run image classification via Workers AI
  // Using a general image classification model — results map to species vocabulary
  let species = 'unknown';
  let confidence = 0;
  let caption = '';

  try {
    const result = await env.AI.run(
      '@cf/meta/llama-3.1-8b-instruct',
      {
        messages: [
          {
            role: 'system',
            content: 'You are a marine echogram analyzer. Given image data from a fish finder, classify what you see. Respond ONLY with a JSON object: {"species": "predicted_species", "confidence": 0.0-1.0, "feed_present": true/false, "caption": "one line description"}. Species options: sockeye, pink, chum, coho, chinook, none, unknown.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Capture ${captureId} at ${capture.ts_utc}. Blob count: ${capture.blob_count_lf || 0}, thermocline count: ${capture.thermocline_count || 0}.` },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64(imageData)}` } },
            ],
          },
        ],
        max_tokens: 200,
      }
    ) as any;

    // Parse LLM response
    const text = result.response || '';
    try {
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
      species = parsed.species || 'unknown';
      confidence = Math.max(0, Math.min(1, parsed.confidence || 0));
      caption = parsed.caption || '';
    } catch {
      // If LLM didn't return valid JSON, use raw text as caption
      caption = text.slice(0, 200);
    }
  } catch (err: any) {
    // AI classification failed — fall back to heuristic from blob counts
    const blobs = capture.blob_count_lf || 0;
    const thermoclines = capture.thermocline_count || 0;
    if (blobs > 15 && thermoclines > 2) {
      species = 'likely_fish';
      confidence = 0.4;
      caption = `High blob density (${blobs}) with thermocline activity (${thermoclines})`;
    } else if (blobs > 5) {
      species = 'possible_fish';
      confidence = 0.2;
      caption = `Moderate blob density (${blobs})`;
    } else {
      species = 'none';
      confidence = 0.5;
      caption = `Low activity (${blobs} blobs)`;
    }
  }

  // Write results back to D1
  await env.DB.prepare(
    `UPDATE captures SET
       vocabulary_species = ?,
       vocabulary_confidence = ?,
       caption = COALESCE(NULLIF(?, ''), caption)
     WHERE capture_id = ?`
  ).bind(species, confidence, caption, captureId).run();

  return {
    capture_id: captureId,
    species,
    confidence,
    caption,
  };
}

async function analyzeBatch(env: Env, limit: number): Promise<AnalysisResult[]> {
  // Get unanalyzed captures that have R2 keys
  const pending = await env.DB.prepare(
    `SELECT capture_id FROM captures
     WHERE vocabulary_species IS NULL AND png_r2_key IS NOT NULL
     ORDER BY ts_utc DESC LIMIT ?`
  ).bind(limit).all();

  const results: AnalysisResult[] = [];
  for (const row of pending.results || []) {
    try {
      const result = await analyzeCapture(env, row.capture_id as string);
      results.push(result);
      // Small delay to avoid hitting AI rate limits
      await new Promise(r => setTimeout(r, 500));
    } catch (err: any) {
      results.push({ capture_id: row.capture_id as string, confidence: 0, error: err.message });
    }
  }
  return results;
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
