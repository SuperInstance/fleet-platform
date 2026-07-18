/**
 * Fleet API Gateway — single entry point for all agency tools
 * 
 * Routes to:
 *   /weather/*     → fleet-weather worker (subrequest)
 *   /sessions/*    → session CRUD
 *   /captures/*    → capture mirror from boat
 *   /training/*    → training labels
 *   /a2a/*         → polyformalism intent messaging
 *   /health        → fleet health check
 *   /brief         → morning brief aggregation
 *   /search        → semantic search (Vectorize)
 *   /vessel/position → last known position
 *   /              → dashboard
 */

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  CACHE: KVNamespace;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      // ── Health ────────────────────────────────────────────
      if (path === '/health') {
        const services = await checkFleetHealth(env);
        return json({ ok: true, time: new Date().toISOString(), services });
      }

      // ── Vessel Position ───────────────────────────────────
      if (path === '/vessel/position') {
        const pos = await env.DB.prepare(
          'SELECT * FROM observations ORDER BY timestamp DESC LIMIT 1'
        ).first();
        return json(pos || { error: 'No observations yet' });
      }

      // ── Sessions ──────────────────────────────────────────
      if (path === '/sessions' && method === 'GET') {
        const parsedLimit = parseInt(url.searchParams.get('limit') || '50');
        const limit = Math.min(100, Number.isFinite(parsedLimit) ? parsedLimit : 50);
        const results = await env.DB.prepare(
          'SELECT id, title, started_at, ended_at, annotation_count, word_count, tags, domain FROM sessions ORDER BY started_at DESC LIMIT ?'
        ).bind(limit).all();
        return json({ sessions: results.results });
      }

      if (path === '/sessions' && method === 'POST') {
        const body = await request.json() as any;
        const id = body.id || `session-${Date.now()}`;
        await env.DB.prepare(
          `INSERT OR REPLACE INTO sessions (id, title, started_at, ended_at, annotation_count, word_count, tags, raw_markdown, domain, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(
          id, body.title || null, body.started_at, body.ended_at || null,
          body.annotation_count || 0, body.word_count || 0,
          JSON.stringify(body.tags || []), body.raw_markdown || '',
          body.domain || 'generic'
        ).run();

        // Insert annotations if provided
        if (body.annotations) {
          for (const ann of body.annotations) {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO annotations (id, session_id, timestamp, latitude, longitude, speed, heading, depth, water_temp, text_before, text_after, tags, important)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              `${id}-${ann.timestamp}`, id, ann.timestamp,
              ann.latitude || null, ann.longitude || null,
              ann.speed || null, ann.heading || null,
              ann.depth || null, ann.water_temp || null,
              ann.text_before || null, ann.text_after || null,
              JSON.stringify(ann.tags || []), ann.important ? 1 : 0
            ).run();
          }
        }

        // Vectorize transcript for semantic search
        if (env.VECTORIZE && body.raw_markdown) {
          const embedding = await env.AI.run('@cf/baai/bge-small-en-v1.5', {
            text: body.raw_markdown.slice(0, 512)
          }) as any;
          if (embedding.data?.[0]) {
            await env.VECTORIZE.insert([{
              id,
              values: embedding.data[0],
              metadata: { started_at: body.started_at, domain: body.domain || 'generic', type: 'session' }
            }]);
          }
        }

        return json({ ok: true, id, annotations: body.annotations?.length || 0 });
      }

      // ── Captures ──────────────────────────────────────────
      if (path === '/captures' && method === 'GET') {
        const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50'));
        const results = await env.DB.prepare(
          'SELECT * FROM captures ORDER BY ts_utc DESC LIMIT ?'
        ).bind(limit).all();
        return json({ captures: results.results });
      }

      if (path === '/captures' && method === 'POST') {
        const body = await request.json() as any;
        await env.DB.prepare(
          `INSERT OR REPLACE INTO captures (capture_id, ts_utc, lat, lon, sog_kts, cog_deg, bottom_depth_fm, blob_count_lf, thermocline_count, vocabulary_species, vocabulary_confidence, caption, raw_json, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(
          body.capture_id, body.ts_utc, body.lat, body.lon,
          body.sog_kts, body.cog_deg, body.bottom_depth_fm,
          body.blob_count_lf, body.thermocline_count,
          body.vocabulary_species, body.vocabulary_confidence,
          body.caption, body.raw_json
        ).run();
        return json({ ok: true, capture_id: body.capture_id });
      }

      // ── Training Labels ───────────────────────────────────
      if (path === '/training-labels' && method === 'GET') {
        const results = await env.DB.prepare(
          'SELECT * FROM training_labels ORDER BY timestamp DESC LIMIT 100'
        ).all();
        return json({ labels: results.results });
      }

      if (path === '/training-labels' && method === 'POST') {
        const body = await request.json() as any;
        const id = body.id || `label-${Date.now()}`;
        await env.DB.prepare(
          `INSERT OR REPLACE INTO training_labels (id, capture_id, session_id, timestamp, label_type, species, captain_text, vocabulary_was_species, vocabulary_was_confidence, depth_fm)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id, body.capture_id, body.session_id, body.timestamp,
          body.label_type, body.species, body.captain_text,
          body.vocabulary_was_species, body.vocabulary_was_confidence,
          body.depth_fm
        ).run();
        return json({ ok: true, id });
      }

      // ── A2A Messages (polyformalism) ──────────────────────
      if (path === '/a2a/messages' && method === 'GET') {
        const results = await env.DB.prepare(
          'SELECT * FROM a2a_messages ORDER BY timestamp DESC LIMIT 50'
        ).all();
        return json({ messages: results.results });
      }

      if (path === '/a2a/messages' && method === 'POST') {
        const body = await request.json() as any;
        const id = `msg-${Date.now()}`;
        await env.DB.prepare(
          `INSERT INTO a2a_messages (id, sender, receiver, timestamp, channel_data, message, stakes, precision_class, alignment_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id, body.sender, body.receiver, body.timestamp || new Date().toISOString(),
          JSON.stringify(body.channel_data || {}), body.message,
          body.stakes || 0, body.precision_class || 'INT8',
          body.alignment_score || null
        ).run();
        return json({ ok: true, id });
      }

      // ── Semantic Search ───────────────────────────────────
      if (path === '/search' && method === 'GET') {
        const q = url.searchParams.get('q');
        if (!q) return json({ error: 'Query required' }, 400);

        if (env.VECTORIZE) {
          const embedding = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: q }) as any;
          if (embedding.data?.[0]) {
            const results = await env.VECTORIZE.query(embedding.data[0], {
              topK: 20, returnMetadata: true
            });
            return json({ query: q, results: results.matches, mode: 'semantic' });
          }
        }

        // Fallback: text search
        const results = await env.DB.prepare(
          `SELECT id, title, started_at, substr(raw_markdown, 1, 200) as preview FROM sessions WHERE raw_markdown LIKE ? LIMIT 20`
        ).bind(`%${q}%`).all();
        return json({ query: q, results: results.results, mode: 'text' });
      }

      // ── Morning Brief ─────────────────────────────────────
      if (path === '/brief') {
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        const [weather, tides, sessions, captures, obs, corrections] = await Promise.all([
          env.DB.prepare('SELECT * FROM weather_log ORDER BY timestamp DESC LIMIT 24').all(),
          env.CACHE.get('tides:latest'),
          env.DB.prepare('SELECT id, title, started_at, word_count, annotation_count, tags FROM sessions WHERE date(started_at) = ? ORDER BY started_at').bind(yesterday).all(),
          env.DB.prepare('SELECT capture_id, ts_utc, vocabulary_species, vocabulary_confidence, caption FROM captures WHERE date(ts_utc) = ? ORDER BY ts_utc').bind(yesterday).all(),
          env.DB.prepare('SELECT COUNT(*) as c FROM observations WHERE date(timestamp) = ?').bind(yesterday).first(),
          env.DB.prepare('SELECT * FROM training_labels WHERE date(timestamp) = ? AND label_type = ?').bind(yesterday, 'correction').all(),
        ]);

        return json({
          date: today,
          yesterday: yesterday,
          weather_24h: weather.results,
          tides: tides ? JSON.parse(tides) : null,
          yesterday_sessions: sessions.results,
          yesterday_captures: captures.results,
          yesterday_observations: obs?.c || 0,
          vocabulary_corrections: corrections.results,
          generated_at: new Date().toISOString(),
        });
      }

      // ── Weather ingest ────────────────────────────────────
      if (path === '/weather/ingest' && method === 'POST') {
        const body = await request.json() as any;
        await env.DB.prepare(
          `INSERT INTO observations (timestamp, lat, lon, depth_fm, water_temp_c, speed_kts, heading_deg, source, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          body.timestamp || new Date().toISOString(),
          body.lat, body.lon, body.depth_fm || null,
          body.water_temp_c || null, body.speed_kts || null,
          body.heading_deg || null, body.source || 'vessel', JSON.stringify(body)
        ).run();
        return json({ ok: true });
      }

      // ── Catch labels ──────────────────────────────────────
      if (path === '/catch' && method === 'POST') {
        const body = await request.json() as any;
        await env.DB.prepare(
          `INSERT INTO catch_labels (capture_id, session_id, species, depth_fm, count, source, confirmed_by, raw_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          body.capture_id || null, body.session_id || null,
          body.species, body.depth_fm || null, body.count || null,
          body.source || 'fishinglog', body.confirmed_by || null, body.raw_text || null
        ).run();
        return json({ ok: true });
      }

      // ── Fleet Stats ───────────────────────────────────────
      if (path === '/stats') {
        const [sessions, captures, labels, obs, weather] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) as c FROM sessions').first(),
          env.DB.prepare('SELECT COUNT(*) as c FROM captures').first(),
          env.DB.prepare('SELECT COUNT(*) as c FROM training_labels').first(),
          env.DB.prepare('SELECT COUNT(*) as c FROM observations').first(),
          env.DB.prepare('SELECT COUNT(*) as c FROM weather_log').first(),
        ]);
        return json({
          sessions: sessions?.c || 0,
          captures: captures?.c || 0,
          training_labels: labels?.c || 0,
          observations: obs?.c || 0,
          weather_records: weather?.c || 0,
        });
      }

      return json({ error: 'Not found', path, available: [
        '/health', '/sessions', '/captures', '/training-labels',
        '/a2a/messages', '/search', '/brief', '/stats',
        '/vessel/position', '/weather/ingest', '/catch'
      ]}, 404);

    } catch(err: any) {
      return json({ error: err.message }, 500);
    }
  },
};

async function checkFleetHealth(env: Env) {
  const services: any = {};
  try {
    const c = await env.DB.prepare('SELECT COUNT(*) as c FROM sessions').first();
    services.d1 = { ok: true, sessions: c?.c || 0 };
  } catch(e) { services.d1 = { ok: false }; }
  try {
    services.vectorize = { ok: !!env.VECTORIZE };
  } catch(e) { services.vectorize = { ok: false }; }
  try {
    services.ai = { ok: !!env.AI };
  } catch(e) { services.ai = { ok: false }; }
  return services;
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
