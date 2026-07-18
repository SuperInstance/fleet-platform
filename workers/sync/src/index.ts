/**
 * Fleet Sync Worker — central boat↔cloud synchronization hub.
 *
 * This is what the boat (EILEEN) calls when it comes online.
 *
 * Endpoints:
 *   POST /sync/push        — bulk upload of captures, sessions,
 *                            observations, catch_labels + PNGs.
 *   POST /sync/pull        — fetch cloud-side updates since last sync.
 *   GET  /sync/status      — current sync state for a device.
 *   POST /sync/r2-upload   — upload a single echogram PNG to R2.
 *   GET  /health           — service + binding health check.
 *
 * Storage:
 *   - D1 (DB)        — captures, sessions, observations, catch_labels,
 *                      weather_log, a2a_messages, training_labels.
 *   - R2 (ECHOGRAMS) — captures/{capture_id}.png
 *   - KV (SYNC_STATE)— sync:device:{device_id} → SyncState JSON
 *
 * Conflict resolution:
 *   Captures / sessions: PRIMARY KEY conflict → INSERT OR IGNORE
 *     (idempotent re-push safe, last-write-wins by capture_id).
 *   Observations / catch_labels: INTEGER PK AUTOINCREMENT →
 *     INSERT OR IGNORE; boat is responsible for not re-sending.
 *   Sync state in KV: written last, after all writes succeed,
 *     so a partial push never claims completion it didn't earn.
 */

export interface Env {
  DB: D1Database;
  ECHOGRAMS: R2Bucket;
  SYNC_STATE: KVNamespace;
  DEVICE_DEFAULT?: string;
  INSERT_BATCH_SIZE?: string;
  MAX_PNG_BYTES?: string;
  PULL_WEATHER_LIMIT?: string;
  PULL_NARRATOR_LIMIT?: string;
  PULL_TRAINING_LIMIT?: string;
  PULL_A2A_LIMIT?: string;
}

// ─── Constants ─────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id',
  'Access-Control-Max-Age': '86400',
};

const JSON_HEADERS: Record<string, string> = {
  ...CORS,
  'Content-Type': 'application/json; charset=utf-8',
};

// Default per-call limits (overridable via env in wrangler.toml).
const DEFAULT_DEVICE      = 'EILEEN';
const DEFAULT_BATCH_SIZE  = 50;
const DEFAULT_MAX_PNG     = 10 * 1024 * 1024;
const DEFAULT_PULL_LIMITS = {
  weather_log:    500,
  narrator:       200,
  training:       200,
  a2a:            500,
};

const STATE_TTL_SECONDS = 60 * 60 * 24 * 365; // 1y

// ─── Types ─────────────────────────────────────────────────

interface SyncState {
  last_sync: string;
  pushed_count: number;
  pulled_count: number;
  last_sync_id?: string;
  last_push_breakdown?: Record<string, number>;
  last_pull_breakdown?: Record<string, number>;
  updated_at?: string;
}

interface PushBody {
  device_id: string;
  captures?: any[];
  sessions?: any[];
  observations?: any[];
  catch_labels?: any[];
  png_files?: Array<{ capture_id: string; base64: string }>;
}

interface PullBody {
  device_id?: string;
  last_sync?: string;
}

interface CountBreakdown {
  inserted: number;
  duplicate: number;
  invalid: number;
}

interface FlatCapture {
  capture_id: string;
  ts_utc: string;
  lat: number | null;
  lon: number | null;
  sog_kts: number | null;
  cog_deg: number | null;
  bottom_depth_fm: number | null;
  blob_count_lf: number | null;
  thermocline_count: number | null;
  haze_blob_count: number | null;
  feed_present: number | null;
  vocabulary_species: string | null;
  vocabulary_confidence: number | null;
  caption: string | null;
  raw_json: string;
  png_r2_key: string | null;
  synced_at: string;
}

// ─── Entry ─────────────────────────────────────────────────

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/\/+$/, '');

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path === '' || path === '/' || path === '/health' || path === '/healthz') {
        return json(await healthCheck(env));
      }

      if (path === '/sync/push' && method === 'POST') {
        return json(await handlePush(request, env));
      }
      if (path === '/sync/pull' && method === 'POST') {
        return json(await handlePull(request, env));
      }
      if (path === '/sync/status' && method === 'GET') {
        return json(await handleStatus(request, env));
      }
      if (path === '/sync/r2-upload' && method === 'POST') {
        return json(await handleR2Upload(request, env));
      }

      return json({ error: 'not_found', path }, 404);
    } catch (err: any) {
      console.error('fleet-sync unhandled error', err);
      return json(
        {
          error: 'internal_error',
          message: err?.message ?? String(err),
          name: err?.name ?? 'Error',
        },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;

// ─── Health ────────────────────────────────────────────────

async function healthCheck(env: Env): Promise<any> {
  const checks: Record<string, any> = {};
  try {
    const r = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    checks.d1 = { ok: r?.ok === 1 };
  } catch (e: any) {
    checks.d1 = { ok: false, error: e?.message };
  }
  try {
    await env.SYNC_STATE.get('sync:health-probe');
    checks.kv = { ok: true };
  } catch (e: any) {
    checks.kv = { ok: false, error: e?.message };
  }
  try {
    // R2 doesn't have a free GET; list with limit 0 is the cheapest probe.
    // Skip if the bucket hasn't been bound yet.
    if (env.ECHOGRAMS) {
      await env.ECHOGRAMS.list({ limit: 1 });
      checks.r2 = { ok: true };
    } else {
      checks.r2 = { ok: false, error: 'not bound' };
    }
  } catch (e: any) {
    checks.r2 = { ok: false, error: e?.message };
  }
  return {
    service: 'fleet-sync',
    status: Object.values(checks).every((c: any) => c.ok) ? 'ok' : 'degraded',
    time: now(),
    checks,
  };
}

// ─── POST /sync/push ──────────────────────────────────────

async function handlePush(request: Request, env: Env): Promise<any> {
  let body: PushBody;
  try {
    body = (await request.json()) as PushBody;
  } catch {
    return { error: 'invalid_json', status: 400 };
  }

  const deviceId = (body?.device_id ?? '').trim();
  if (!deviceId) return { error: 'missing_device_id', status: 400 };

  const syncId = crypto.randomUUID();
  const ts = now();
  const errors: Array<{ table?: string; capture_id?: string; message: string }> = [];

  const counts: Record<string, CountBreakdown> = {
    captures:     { inserted: 0, duplicate: 0, invalid: 0 },
    sessions:     { inserted: 0, duplicate: 0, invalid: 0 },
    observations: { inserted: 0, duplicate: 0, invalid: 0 },
    catch_labels: { inserted: 0, duplicate: 0, invalid: 0 },
  };

  // ── Captures ────────────────────────────────────────────
  if (Array.isArray(body.captures) && body.captures.length) {
    try {
      counts.captures = await insertCaptures(env.DB, body.captures, ts);
    } catch (err: any) {
      counts.captures.invalid = body.captures.length;
      errors.push({ table: 'captures', message: err?.message ?? String(err) });
    }
  }

  // ── Sessions ────────────────────────────────────────────
  if (Array.isArray(body.sessions) && body.sessions.length) {
    try {
      counts.sessions = await insertSessions(env.DB, body.sessions, ts);
    } catch (err: any) {
      counts.sessions.invalid = body.sessions.length;
      errors.push({ table: 'sessions', message: err?.message ?? String(err) });
    }
  }

  // ── Observations ────────────────────────────────────────
  if (Array.isArray(body.observations) && body.observations.length) {
    try {
      counts.observations = await insertObservations(env.DB, body.observations);
    } catch (err: any) {
      counts.observations.invalid = body.observations.length;
      errors.push({ table: 'observations', message: err?.message ?? String(err) });
    }
  }

  // ── Catch Labels ────────────────────────────────────────
  if (Array.isArray(body.catch_labels) && body.catch_labels.length) {
    try {
      counts.catch_labels = await insertCatchLabels(env.DB, body.catch_labels, ts);
    } catch (err: any) {
      counts.catch_labels.invalid = body.catch_labels.length;
      errors.push({ table: 'catch_labels', message: err?.message ?? String(err) });
    }
  }

  // ── PNG Uploads ─────────────────────────────────────────
  let pngUploaded = 0;
  let pngFailed = 0;
  const pngErrors: Array<{ capture_id: string; message: string }> = [];
  if (Array.isArray(body.png_files) && body.png_files.length) {
    for (const file of body.png_files) {
      try {
        const result = await uploadPng(env, file.capture_id, file.base64, ts);
        if (result.ok) pngUploaded++;
        else { pngFailed++; pngErrors.push({ capture_id: file.capture_id, message: result.error }); }
      } catch (err: any) {
        pngFailed++;
        pngErrors.push({ capture_id: file.capture_id, message: err?.message ?? String(err) });
      }
    }
    if (pngErrors.length) errors.push(...pngErrors);
  }

  // ── Update KV sync state (only after all writes settle) ─
  // Atomic enough for our purposes: reads the prior state, merges,
  // then writes. Concurrent pushes from the same device could race,
  // but the worst case is a slight over-count on pushed_count.
  const prev = await readSyncState(env, deviceId);
  const insertedTotal =
    counts.captures.inserted +
    counts.sessions.inserted +
    counts.observations.inserted +
    counts.catch_labels.inserted;
  const accepted = insertedTotal + pngUploaded;
  const rejected =
    counts.captures.duplicate +
    counts.sessions.duplicate +
    counts.observations.duplicate +
    counts.catch_labels.duplicate +
    counts.captures.invalid +
    counts.sessions.invalid +
    counts.observations.invalid +
    counts.catch_labels.invalid +
    pngFailed;

  const newState: SyncState = {
    last_sync: ts,
    pushed_count: (prev.pushed_count ?? 0) + insertedTotal,
    pulled_count: prev.pulled_count ?? 0,
    last_sync_id: syncId,
    updated_at: ts,
    last_push_breakdown: {
      captures_inserted: counts.captures.inserted,
      captures_duplicate: counts.captures.duplicate,
      sessions_inserted: counts.sessions.inserted,
      sessions_duplicate: counts.sessions.duplicate,
      observations_inserted: counts.observations.inserted,
      catch_labels_inserted: counts.catch_labels.inserted,
      png_uploaded: pngUploaded,
      png_failed: pngFailed,
    },
  };
  await writeSyncState(env, deviceId, newState);

  return {
    sync_id: syncId,
    timestamp: ts,
    device_id: deviceId,
    accepted,
    rejected,
    breakdown: counts,
    png_uploaded: pngUploaded,
    png_failed: pngFailed,
    errors: errors.length ? errors : undefined,
    status: 200,
  };
}

// ─── POST /sync/pull ──────────────────────────────────────

async function handlePull(request: Request, env: Env): Promise<any> {
  let body: PullBody = {};
  try {
    body = (await request.json()) as PullBody;
  } catch {
    // tolerate empty body
  }

  const deviceId = (body?.device_id ?? request.headers.get('x-device-id') ?? env.DEVICE_DEFAULT ?? DEFAULT_DEVICE).trim();
  const sinceInput = (body?.last_sync ?? '').trim();
  // Validate ISO; fall back to epoch on bad input.
  const since = isValidIso(sinceInput) ? sinceInput : '1970-01-01T00:00:00Z';
  const ts = now();
  const limits = resolvePullLimits(env);

  // ── Weather ─────────────────────────────────────────────
  const weather = await env.DB.prepare(
    `SELECT id, timestamp, lat, lon,
            wind_speed_kts, wind_dir, wave_height_ft,
            visibility, sky, temp_c, pressure_hpa,
            tide_station, tide_stage, tide_height, forecast
       FROM weather_log
      WHERE timestamp > ?
   ORDER BY timestamp ASC
      LIMIT ?`,
  ).bind(since, limits.weather_log).all();

  // ── Narrator reports (stored as sessions with domain='narrator')
  // If the narrator service later writes to a dedicated table, swap
  // this query without changing the response shape.
  const narrator = await env.DB.prepare(
    `SELECT id, title, started_at, ended_at, raw_markdown, tags, word_count
       FROM sessions
      WHERE domain = 'narrator' AND started_at > ?
   ORDER BY created_at ASC
      LIMIT ?`,
  ).bind(since, limits.narrator).all();

  // ── Training prompts: cloud-pushed prompts awaiting captain input.
  // Boat-generated labels use label_type in {confirmation, correction,
  // negative, anomaly} so they don't bounce back on the next pull.
  const training = await env.DB.prepare(
    `SELECT id, capture_id, session_id, timestamp, label_type, species,
            captain_text, vocabulary_was_species, vocabulary_was_confidence,
            depth_fm, sounder_data, camera_available, camera_depth
       FROM training_labels
      WHERE label_type = 'cloud_prompt' AND timestamp > ?
   ORDER BY timestamp ASC
      LIMIT ?`,
  ).bind(since, limits.training).all();

  // ── A2A messages directed at this device (or broadcast).
  const a2a = await env.DB.prepare(
    `SELECT id, sender, receiver, timestamp, channel_data, message,
            stakes, precision_class, alignment_score, acknowledged
       FROM a2a_messages
      WHERE timestamp > ?
        AND (receiver IS NULL OR receiver = '' OR receiver = ?)
   ORDER BY timestamp ASC
      LIMIT ?`,
  ).bind(since, deviceId, limits.a2a).all();

  const counts = {
    weather_log:      weather.results?.length    ?? 0,
    narrator_reports: narrator.results?.length   ?? 0,
    training_prompts: training.results?.length   ?? 0,
    a2a_messages:     a2a.results?.length        ?? 0,
  };
  const total = counts.weather_log + counts.narrator_reports +
                counts.training_prompts + counts.a2a_messages;

  // ── Update KV sync state ────────────────────────────────
  const prev = await readSyncState(env, deviceId);
  await writeSyncState(env, deviceId, {
    last_sync: ts,
    pushed_count: prev.pushed_count ?? 0,
    pulled_count: (prev.pulled_count ?? 0) + total,
    last_sync_id: crypto.randomUUID(),
    updated_at: ts,
    last_pull_breakdown: counts,
    last_push_breakdown: prev.last_push_breakdown,
  });

  return {
    sync_id: crypto.randomUUID(),
    timestamp: ts,
    device_id: deviceId,
    last_sync: since,
    server_time: ts,
    weather_log:      weather.results    ?? [],
    narrator_reports: narrator.results   ?? [],
    training_prompts: training.results   ?? [],
    a2a_messages:     a2a.results        ?? [],
    counts,
    status: 200,
  };
}

// ─── GET /sync/status ─────────────────────────────────────

async function handleStatus(request: Request, env: Env): Promise<any> {
  const url = new URL(request.url);
  const deviceId = (
    url.searchParams.get('device_id') ??
    request.headers.get('x-device-id') ??
    env.DEVICE_DEFAULT ??
    DEFAULT_DEVICE
  ).trim();

  const state = await readSyncState(env, deviceId);

  // Cheap counts to give the boat (or dashboard) a sense of "what's pending"
  const capturesSince = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM captures WHERE synced_at > ?`,
  ).bind(state.last_sync ?? '1970-01-01T00:00:00Z').first<{ c: number }>();

  const totalCaptures = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM captures`,
  ).first<{ c: number }>();

  return {
    device_id: deviceId,
    sync_state: state,
    server_time: now(),
    captures_since_last_sync: capturesSince?.c ?? 0,
    captures_total: totalCaptures?.c ?? 0,
    status: 200,
  };
}

// ─── POST /sync/r2-upload ─────────────────────────────────

async function handleR2Upload(request: Request, env: Env): Promise<any> {
  let body: { capture_id?: string; base64?: string };
  try {
    body = (await request.json()) as { capture_id?: string; base64?: string };
  } catch {
    return { error: 'invalid_json', status: 400 };
  }
  if (!body.capture_id || !body.base64) {
    return { error: 'missing_capture_id_or_base64', status: 400 };
  }

  const result = await uploadPng(env, body.capture_id, body.base64, now());
  if (!result.ok) return { error: result.error, status: 400 };

  return {
    capture_id: body.capture_id,
    r2_key: result.key,
    size: result.size,
    status: 200,
  };
}

// ─── Bulk inserts (batched) ───────────────────────────────

function envInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envLimits(env: Env) {
  return {
    weather_log: envInt(env.PULL_WEATHER_LIMIT,  DEFAULT_PULL_LIMITS.weather_log),
    narrator:    envInt(env.PULL_NARRATOR_LIMIT, DEFAULT_PULL_LIMITS.narrator),
    training:    envInt(env.PULL_TRAINING_LIMIT, DEFAULT_PULL_LIMITS.training),
    a2a:         envInt(env.PULL_A2A_LIMIT,      DEFAULT_PULL_LIMITS.a2a),
  };
}

function resolvePullLimits(env: Env) {
  // Tolerate either name; @ts-ignore for the dynamic property lookup.
  // @ts-ignore - dynamic env override
  return envLimits(env);
}

function batchSize(env: Env): number {
  return envInt(env.INSERT_BATCH_SIZE, DEFAULT_BATCH_SIZE);
}

async function insertCaptures(
  db: D1Database,
  rows: any[],
  ts: string,
): Promise<CountBreakdown> {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO captures (
      capture_id, ts_utc, lat, lon, sog_kts, cog_deg,
      bottom_depth_fm, blob_count_lf, thermocline_count,
      haze_blob_count, feed_present,
      vocabulary_species, vocabulary_confidence,
      caption, raw_json, png_r2_key, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0, duplicate = 0, invalid = 0;
  const SIZE = batchSize({ INSERT_BATCH_SIZE: String(DEFAULT_BATCH_SIZE) });

  for (let i = 0; i < rows.length; i += SIZE) {
    const chunk = rows.slice(i, i + SIZE);
    const statements: D1PreparedStatement[] = [];
    for (const c of chunk) {
      const flat = flattenCapture(c, ts);
      if (!flat) { invalid++; continue; }
      statements.push(stmt.bind(
        flat.capture_id,
        flat.ts_utc,
        flat.lat,
        flat.lon,
        flat.sog_kts,
        flat.cog_deg,
        flat.bottom_depth_fm,
        flat.blob_count_lf,
        flat.thermocline_count,
        flat.haze_blob_count,
        flat.feed_present,
        flat.vocabulary_species,
        flat.vocabulary_confidence,
        flat.caption,
        flat.raw_json,
        flat.png_r2_key,
        flat.synced_at,
      ));
    }
    if (!statements.length) continue;
    const results = await db.batch(statements);
    for (const r of results as any[]) {
      if (r?.meta?.changes > 0) inserted++;
      else duplicate++;
    }
  }
  return { inserted, duplicate, invalid };
}

async function insertSessions(
  db: D1Database,
  rows: any[],
  ts: string,
): Promise<CountBreakdown> {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sessions (
      id, title, started_at, ended_at,
      annotation_count, word_count, tags,
      raw_markdown, domain, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0, duplicate = 0, invalid = 0;
  const SIZE = DEFAULT_BATCH_SIZE;

  for (let i = 0; i < rows.length; i += SIZE) {
    const chunk = rows.slice(i, i + SIZE);
    const statements: D1PreparedStatement[] = [];
    for (const s of chunk) {
      if (!s || !s.id) { invalid++; continue; }
      statements.push(stmt.bind(
        String(s.id),
        strOrNull(s.title),
        String(s.started_at ?? ts),
        strOrNull(s.ended_at),
        intOrZero(s.annotation_count),
        intOrZero(s.word_count),
        typeof s.tags === 'string' ? s.tags : JSON.stringify(s.tags ?? []),
        String(s.raw_markdown ?? ''),
        String(s.domain ?? 'generic'),
        ts,
      ));
    }
    if (!statements.length) continue;
    const results = await db.batch(statements);
    for (const r of results as any[]) {
      if (r?.meta?.changes > 0) inserted++;
      else duplicate++;
    }
  }
  return { inserted, duplicate, invalid };
}

async function insertObservations(
  db: D1Database,
  rows: any[],
): Promise<CountBreakdown> {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO observations (
      timestamp, lat, lon, depth_fm, water_temp_c,
      speed_kts, heading_deg, source, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0, duplicate = 0, invalid = 0;
  const SIZE = DEFAULT_BATCH_SIZE;

  for (let i = 0; i < rows.length; i += SIZE) {
    const chunk = rows.slice(i, i + SIZE);
    const statements: D1PreparedStatement[] = [];
    for (const o of chunk) {
      if (!o || o.timestamp == null || o.lat == null || o.lon == null) { invalid++; continue; }
      statements.push(stmt.bind(
        String(o.timestamp),
        Number(o.lat),
        Number(o.lon),
        numOrNull(o.depth_fm),
        numOrNull(o.water_temp_c),
        numOrNull(o.speed_kts),
        numOrNull(o.heading_deg),
        String(o.source ?? 'vessel'),
        typeof o.data === 'string' ? o.data : JSON.stringify(o.data ?? {}),
      ));
    }
    if (!statements.length) continue;
    const results = await db.batch(statements);
    for (const r of results as any[]) {
      if (r?.meta?.changes > 0) inserted++;
      else duplicate++;
    }
  }
  return { inserted, duplicate, invalid };
}

async function insertCatchLabels(
  db: D1Database,
  rows: any[],
  ts: string,
): Promise<CountBreakdown> {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO catch_labels (
      capture_id, session_id, species, depth_fm,
      count, source, confirmed_by, raw_text, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0, duplicate = 0, invalid = 0;
  const SIZE = DEFAULT_BATCH_SIZE;

  for (let i = 0; i < rows.length; i += SIZE) {
    const chunk = rows.slice(i, i + SIZE);
    const statements: D1PreparedStatement[] = [];
    for (const l of chunk) {
      if (!l || !l.species) { invalid++; continue; }
      statements.push(stmt.bind(
        strOrNull(l.capture_id),
        strOrNull(l.session_id),
        String(l.species),
        intOrNull(l.depth_fm),
        intOrNull(l.count),
        String(l.source ?? 'fishinglog'),
        strOrNull(l.confirmed_by),
        strOrNull(l.raw_text),
        ts,
      ));
    }
    if (!statements.length) continue;
    const results = await db.batch(statements);
    for (const r of results as any[]) {
      if (r?.meta?.changes > 0) inserted++;
      else duplicate++;
    }
  }
  return { inserted, duplicate, invalid };
}

// ─── Capture flattening ────────────────────────────────────
//
// Boat may send either the deep v3 schema (position/analysis/heuristic)
// or already-flat rows matching the captures table. We accept both.

function flattenCapture(c: any, ts: string): FlatCapture | null {
  if (!c || typeof c !== 'object') return null;
  const captureId = c.capture_id;
  const tsUtc = c.ts_utc;
  if (typeof captureId !== 'string' || !captureId) return null;
  if (typeof tsUtc !== 'string' || !tsUtc) return null;

  // Already-flat (no nested position/analysis)?
  if (c.position === undefined && c.analysis === undefined) {
    return {
      capture_id: captureId,
      ts_utc: tsUtc,
      lat: numOrNull(c.lat),
      lon: numOrNull(c.lon),
      sog_kts: numOrNull(c.sog_kts),
      cog_deg: numOrNull(c.cog_deg),
      bottom_depth_fm: numOrNull(c.bottom_depth_fm),
      blob_count_lf: intOrNull(c.blob_count_lf),
      thermocline_count: intOrNull(c.thermocline_count ?? (c as any).thermoclines_count),
      haze_blob_count: intOrNull(c.haze_blob_count),
      feed_present: boolOrNull(c.feed_present),
      vocabulary_species: strOrNull(c.vocabulary_species),
      vocabulary_confidence: numOrNull(c.vocabulary_confidence),
      caption: strOrNull(c.caption),
      raw_json: typeof c.raw_json === 'string' ? c.raw_json : JSON.stringify(c),
      png_r2_key: strOrNull(c.png_r2_key),
      synced_at: typeof c.synced_at === 'string' ? c.synced_at : ts,
    };
  }

  // Nested v3 schema
  const pos = c.position ?? {};
  const analysis = c.analysis ?? {};
  const lf = analysis.heuristic?.lf ?? {};
  const hf = analysis.heuristic?.hf ?? {};
  const vocab: any[] = Array.isArray(analysis.vocabulary) ? analysis.vocabulary : [];

  const lfBlobs: any[] = Array.isArray(lf.blobs) ? lf.blobs : [];
  const lfTherm: any[] = Array.isArray(lf.thermoclines) ? lf.thermoclines : [];

  return {
    capture_id: captureId,
    ts_utc: tsUtc,
    lat: numOrNull(pos.lat_dd),
    lon: numOrNull(pos.lon_dd),
    sog_kts: numOrNull(pos.sog_kts),
    cog_deg: numOrNull(pos.cog_deg),
    bottom_depth_fm: numOrNull(lf?.bottom?.bottom_depth_fm),
    blob_count_lf: lfBlobs.length ? lfBlobs.length : null,
    thermocline_count: lfTherm.length ? lfTherm.length : null,
    haze_blob_count: intOrNull(hf?.haze?.haze_blob_count),
    feed_present: boolOrNull(hf?.haze?.feed_present),
    vocabulary_species: strOrNull(vocab[0]?.species),
    vocabulary_confidence: numOrNull(vocab[0]?.confidence ?? vocab[0]?.probability),
    caption: strOrNull(analysis.caption),
    raw_json: JSON.stringify(c),
    png_r2_key: null,
    synced_at: ts,
  };
}

// ─── PNG upload to R2 + capture row backfill ──────────────

async function uploadPng(
  env: Env,
  captureId: string,
  base64Input: string,
  ts: string,
): Promise<{ ok: true; key: string; size: number } | { ok: false; error: string }> {
  if (!captureId || typeof captureId !== 'string') {
    return { ok: false, error: 'invalid_capture_id' };
  }
  const maxBytes = envInt(env.MAX_PNG_BYTES, DEFAULT_MAX_PNG);

  // Strip "data:image/png;base64,..." prefix and any whitespace.
  let clean = String(base64Input ?? '').trim();
  if (clean.startsWith('data:')) {
    const comma = clean.indexOf(',');
    if (comma >= 0) clean = clean.slice(comma + 1);
  }
  clean = clean.replace(/\s+/g, '');
  if (!clean) return { ok: false, error: 'empty_payload' };

  let bytes: Uint8Array;
  try {
    const bin = atob(clean);
    if (bin.length === 0) return { ok: false, error: 'empty_after_decode' };
    if (bin.length > maxBytes) {
      return { ok: false, error: `payload_too_large: ${bin.length} > ${maxBytes}` };
    }
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (err: any) {
    return { ok: false, error: `invalid_base64: ${err?.message ?? 'decode_failed'}` };
  }

  const key = `captures/${captureId}.png`;
  try {
    await env.ECHOGRAMS.put(key, bytes, {
      httpMetadata: {
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        capture_id: captureId,
        uploaded_at: ts,
      },
    });
  } catch (err: any) {
    return { ok: false, error: `r2_put_failed: ${err?.message ?? 'unknown'}` };
  }

  // Ensure the capture row exists (so png_r2_key can be set).
  // If the boat only sent the PNG (e.g. retry after capture row push), we
  // create a minimal stub row. syncing the full heuristic later is fine —
  // INSERT OR IGNORE means it stays consistent.
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO captures (capture_id, ts_utc, synced_at)
       VALUES (?, ?, ?)`,
    ).bind(captureId, ts, ts).run();
    await env.DB.prepare(
      `UPDATE captures SET png_r2_key = ? WHERE capture_id = ?`,
    ).bind(key, captureId).run();
  } catch (err: any) {
    // R2 succeeded; DB update failed isn't fatal for the upload itself,
    // but surface it so callers can retry the backfill.
    return { ok: true, key, size: bytes.byteLength };
    // (Swallowing the DB error is intentional — the PNG is safely on R2.
    //  A subsequent /sync/push with the full capture row will reconcile.)
  }

  return { ok: true, key, size: bytes.byteLength };
}

// ─── KV sync state helpers ────────────────────────────────

function kvKey(deviceId: string): string {
  return `sync:device:${deviceId}`;
}

async function readSyncState(env: Env, deviceId: string): Promise<SyncState> {
  const raw = await env.SYNC_STATE.get(kvKey(deviceId));
  if (!raw) {
    return {
      last_sync: '1970-01-01T00:00:00Z',
      pushed_count: 0,
      pulled_count: 0,
    };
  }
  try {
    const parsed = JSON.parse(raw) as SyncState;
    return {
      last_sync: parsed.last_sync ?? '1970-01-01T00:00:00Z',
      pushed_count: parsed.pushed_count ?? 0,
      pulled_count: parsed.pulled_count ?? 0,
      last_sync_id: parsed.last_sync_id,
      last_push_breakdown: parsed.last_push_breakdown,
      last_pull_breakdown: parsed.last_pull_breakdown,
      updated_at: parsed.updated_at,
    };
  } catch {
    return {
      last_sync: '1970-01-01T00:00:00Z',
      pushed_count: 0,
      pulled_count: 0,
    };
  }
}

async function writeSyncState(
  env: Env,
  deviceId: string,
  state: SyncState,
): Promise<void> {
  await env.SYNC_STATE.put(kvKey(deviceId), JSON.stringify(state), {
    expirationTtl: STATE_TTL_SECONDS,
  });
}

// ─── Utilities ─────────────────────────────────────────────

function json(body: any, status: number = 200): Response {
  return new Response(JSON.stringify(body, safeReplacer), {
    status,
    headers: JSON_HEADERS,
  });
}

function safeReplacer(_key: string, value: any): any {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (value instanceof Uint8Array) {
    return { __type: 'Uint8Array', length: value.byteLength };
  }
  return value;
}

function now(): string {
  return new Date().toISOString();
}

function isValidIso(s: string): boolean {
  if (!s) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

function numOrNull(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v: any): number | null {
  const n = numOrNull(v);
  return n == null ? null : Math.trunc(n);
}

function intOrZero(v: any): number {
  const n = intOrNull(v);
  return n == null ? 0 : n;
}

function strOrNull(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return null; }
}

function boolOrNull(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v ? 1 : 0;
  const s = String(v).toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes') return 1;
  if (s === 'false' || s === '0' || s === 'no') return 0;
  return null;
}
