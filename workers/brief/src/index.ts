/**
 * Fleet Morning Brief — Daily 03:00 UTC intelligence report
 *
 * Runs before Casey wakes (~04:00 UTC). Aggregates yesterday's:
 *   - Captures and vision analysis results
 *   - Catch labels and training corrections
 *   - Weather conditions
 *   - Narrator report (from 22:00 run)
 *   - System health
 *
 * Produces a concise markdown brief stored in R2 + D1.
 *
 * Endpoints:
 *   GET  /brief/latest       — get most recent brief
 *   GET  /brief/:date        — get brief for specific date (YYYY-MM-DD)
 *   POST /brief/generate     — manually trigger brief generation
 *   GET  /health             — service health
 */

export interface Env {
  DB: D1Database;
  BRIEFS: R2Bucket;
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

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (path === '/health') {
        const latest = await env.BRIEFS.get(`briefs/${todayUTC()}.md`);
        return json({
          ok: true,
          service: 'fleet-morning-brief',
          today_brief: latest ? 'ready' : 'pending',
          schedule: '0 3 * * * UTC',
        });
      }

      if (path === '/brief/latest') {
        const key = `briefs/${todayUTC()}.md`;
        const obj = await env.BRIEFS.get(key);
        if (!obj) {
          // Try yesterday
          const yKey = `briefs/${yesterdayUTC()}.md`;
          const yObj = await env.BRIEFS.get(yKey);
          if (!yObj) return json({ error: 'No briefs available yet' }, 404);
          const text = await yObj.text();
          return new Response(text, { headers: { 'Content-Type': 'text/markdown', ...CORS } });
        }
        const text = await obj.text();
        return new Response(text, { headers: { 'Content-Type': 'text/markdown', ...CORS } });
      }

      const dateMatch = path.match(/^\/brief\/(\d{4}-\d{2}-\d{2})$/);
      if (dateMatch && method === 'GET') {
        const date = dateMatch[1];
        const obj = await env.BRIEFS.get(`briefs/${date}.md`);
        if (!obj) return json({ error: `No brief for ${date}` }, 404);
        const text = await obj.text();
        return new Response(text, { headers: { 'Content-Type': 'text/markdown', ...CORS } });
      }

      if (path === '/brief/generate' && method === 'POST') {
        const date = url.searchParams.get('date') || yesterdayUTC();
        const brief = await generateBrief(env, date);
        return json({ date, written: true, brief_preview: brief.slice(0, 500) });
      }

      return json({ error: 'Not found', path }, 404);
    } catch (err: any) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const date = yesterdayUTC();
    ctx.waitUntil(generateBrief(env, date));
  },
};

// ═══════════════════════════════════════════════════════════════
// Brief generation
// ═══════════════════════════════════════════════════════════════

async function generateBrief(env: Env, date: string): Promise<string> {
  const dayStart = `${date}T00:00:00Z`;
  const dayEnd = `${date}T23:59:59Z`;

  // Gather data in parallel
  const [
    captures,
    catchLabels,
    weather,
    observations,
    narratorReport,
    fleetHealth,
  ] = await Promise.all([
    getCaptureSummary(env, dayStart, dayEnd),
    getCatchSummary(env, dayStart, dayEnd),
    getWeatherSummary(env, dayStart, dayEnd),
    getObservationSummary(env, dayStart, dayEnd),
    getNarratorReport(env, date),
    getFleetHealth(env, dayStart, dayEnd),
  ]);

  // Build the brief
  const lines: string[] = [];
  lines.push(`# ⚓ Fleet Morning Brief — ${date}`);
  lines.push(`*_Generated ${new Date().toISOString()}_*`);
  lines.push('');

  // Vessel position
  if (observations.last) {
    lines.push(`## 📍 Last Known Position`);
    lines.push(`**${observations.last.lat?.toFixed(4)}, ${observations.last.lon?.toFixed(4)}**`);
    if (observations.last.depth_fm) lines.push(`Depth: ${observations.last.depth_fm} fm`);
    if (observations.last.water_temp_c) lines.push(`Water temp: ${observations.last.water_temp_c}°C`);
    lines.push('');
  }

  // Weather
  if (weather.count > 0) {
    lines.push(`## 🌊 Weather`);
    lines.push(`- Wind: ${weather.avg_wind?.toFixed(0) || '?'} kts ${weather.wind_dir || ''}`);
    lines.push(`- Waves: ${weather.avg_wave?.toFixed(1) || '?'} ft`);
    lines.push(`- Pressure: ${weather.avg_pressure?.toFixed(0) || '?'} hPa`);
    lines.push(`- Sky: ${weather.sky || 'n/a'}`);
    lines.push('');
  }

  // Catch
  if (catchLabels.total > 0) {
    lines.push(`## 🐟 Catch Summary`);
    lines.push(`**${catchLabels.total} fish logged**`);
    for (const [species, count] of Object.entries(catchLabels.bySpecies)) {
      lines.push(`- ${species}: ${count}`);
    }
    lines.push('');
  } else {
    lines.push(`## 🐟 Catch Summary`);
    lines.push(`*No catch labels for ${date}*`);
    lines.push('');
  }

  // Captures / Vision
  if (captures.total > 0) {
    lines.push(`## 📸 Echogram Captures`);
    lines.push(`- Total: ${captures.total}`);
    lines.push(`- Analyzed: ${captures.analyzed}`);
    lines.push(`- Feed detected: ${captures.feed_present}`);
    if (captures.topSpecies) {
      lines.push(`- Top species (AI): ${captures.topSpecies}`);
    }
    lines.push('');
  }

  // Narrator insights
  if (narratorReport) {
    lines.push(`## 📝 Narrator Analysis`);
    lines.push(`Caption gaps found: ${narratorReport.gaps || 0}`);
    if (narratorReport.summary) {
      lines.push('');
      lines.push(narratorReport.summary);
    }
    lines.push('');
  }

  // Fleet health
  lines.push(`## 🔧 Fleet Health`);
  if (fleetHealth.issues > 0) {
    lines.push(`⚠️ **${fleetHealth.issues} issues**:`);
    for (const issue of fleetHealth.details) {
      lines.push(`- ${issue.service}: ${issue.status} — ${issue.details || ''}`);
    }
  } else {
    lines.push(`✅ All systems nominal`);
  }
  lines.push('');

  // AI synthesis (optional)
  let aiSummary = '';
  try {
    const summaryInput = lines.join('\n');
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are a concise fishing fleet assistant. Summarize the day\'s data in 2-3 sentences. Highlight anything actionable. Be direct and practical.',
        },
        { role: 'user', content: summaryInput },
      ],
      max_tokens: 200,
    }) as any;
    aiSummary = result.response || '';
  } catch {
    // AI synthesis is nice-to-have, not critical
  }

  if (aiSummary) {
    lines.push(`## 🤖 AI Summary`);
    lines.push(aiSummary);
    lines.push('');
  }

  lines.push('---');
  lines.push('*Fleet Morning Brief — SuperInstance Agency Tools*');

  const brief = lines.join('\n');

  // Write to R2
  await env.BRIEFS.put(`briefs/${date}.md`, brief);

  // Write summary to D1
  await env.DB.prepare(
    `INSERT OR REPLACE INTO fleet_health (service, timestamp, status, details)
     VALUES ('morning-brief', datetime('now'), 'ok', ?)`
  ).bind(JSON.stringify({ date, chars: brief.length })).run();

  return brief;
}

// ═══════════════════════════════════════════════════════════════
// Data gathering helpers
// ═══════════════════════════════════════════════════════════════

async function getCaptureSummary(env: Env, start: string, end: string) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) as total,
       COUNT(vocabulary_species) as analyzed,
       SUM(CASE WHEN feed_present = 1 THEN 1 ELSE 0 END) as feed_present
     FROM captures WHERE ts_utc BETWEEN ? AND ?`
  ).bind(start, end).first() as any;

  const top = await env.DB.prepare(
    `SELECT vocabulary_species, COUNT(*) as cnt
     FROM captures WHERE ts_utc BETWEEN ? AND ? AND vocabulary_species IS NOT NULL
     GROUP BY vocabulary_species ORDER BY cnt DESC LIMIT 1`
  ).bind(start, end).first() as any;

  return {
    total: row?.total || 0,
    analyzed: row?.analyzed || 0,
    feed_present: row?.feed_present || 0,
    topSpecies: top?.vocabulary_species || null,
  };
}

async function getCatchSummary(env: Env, start: string, end: string) {
  // catch_labels don't have timestamps directly — join with sessions
  const rows = await env.DB.prepare(
    `SELECT species, SUM(count) as total FROM catch_labels
     WHERE synced_at BETWEEN ? AND ?
     GROUP BY species`
  ).bind(start, end).all() as any;

  const bySpecies: Record<string, number> = {};
  let total = 0;
  for (const row of rows.results || []) {
    bySpecies[row.species] = row.total;
    total += row.total;
  }
  return { total, bySpecies };
}

async function getWeatherSummary(env: Env, start: string, end: string) {
  const row = await env.DB.prepare(
    `SELECT
       AVG(wind_speed_kts) as avg_wind,
       AVG(wave_height_ft) as avg_wave,
       AVG(pressure_hpa) as avg_pressure,
       sky, wind_dir
     FROM weather_log WHERE timestamp BETWEEN ? AND ?
     GROUP BY sky, wind_dir
     ORDER BY COUNT(*) DESC LIMIT 1`
  ).bind(start, end).first() as any;

  const count = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM weather_log WHERE timestamp BETWEEN ? AND ?`
  ).bind(start, end).first() as any;

  return {
    count: count?.cnt || 0,
    avg_wind: row?.avg_wind,
    avg_wave: row?.avg_wave,
    avg_pressure: row?.avg_pressure,
    sky: row?.sky,
    wind_dir: row?.wind_dir,
  };
}

async function getObservationSummary(env: Env, start: string, end: string) {
  const last = await env.DB.prepare(
    `SELECT lat, lon, depth_fm, water_temp_c, speed_kts, heading_deg
     FROM observations WHERE timestamp BETWEEN ? AND ?
     ORDER BY timestamp DESC LIMIT 1`
  ).bind(start, end).first() as any;

  return { last };
}

async function getNarratorReport(env: Env, date: string) {
  // Check if narrator_reports table exists and has data
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM narrator_reports WHERE date = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(date).first() as any;
    return row;
  } catch {
    return null;
  }
}

async function getFleetHealth(env: Env, start: string, end: string) {
  const rows = await env.DB.prepare(
    `SELECT service, status, details FROM fleet_health
     WHERE timestamp BETWEEN ? AND ? AND status != 'ok'
     ORDER BY timestamp DESC LIMIT 10`
  ).bind(start, end).all() as any;

  const issues = (rows.results || []).length;
  const details = (rows.results || []).map((r: any) => ({
    service: r.service,
    status: r.status,
    details: r.details,
  }));

  return { issues, details };
}
