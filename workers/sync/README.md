# fleet-sync

The central boat↔cloud synchronization hub. EILEEN (and any other device) hits
this worker when it comes online to drain its local queue and pull down any
new cloud-side data.

## Bindings

| Binding     | Type            | Purpose                                                                |
| ----------- | --------------- | ---------------------------------------------------------------------- |
| `DB`        | D1 (`fleet-data`)| `captures`, `sessions`, `observations`, `catch_labels`, `training_labels`, `a2a_messages`, `weather_log` |
| `ECHOGRAMS` | R2 (`fleet-echograms`) | PNG screenshots, keyed `captures/{capture_id}.png`                 |
| `SYNC_STATE`| KV              | Per-device `sync:device:{device_id}` → `{last_sync, pushed_count, pulled_count, ...}` |

## Endpoints

### `POST /sync/push`

Bulk upload from the boat.

```jsonc
{
  "device_id": "EILEEN",
  "captures":      [/* v3 schema or already-flat rows */],
  "sessions":      [/* ActiveLog sessions */],
  "observations":  [/* vessel telemetry */],
  "catch_labels":  [/* catch_link.py output */],
  "png_files":     [{ "capture_id": "1240_...", "base64": "iVBOR..." }]
}
```

Response:
```jsonc
{
  "sync_id": "uuid",
  "timestamp": "2026-07-18T18:55:00Z",
  "device_id": "EILEEN",
  "accepted": 142,      // inserted rows + successful PNGs
  "rejected": 3,        // duplicates + invalid + failed PNGs
  "breakdown": { "captures": {"inserted":120, "duplicate":2, "invalid":0}, ... },
  "png_uploaded": 18,
  "png_failed":   1,
  "errors":      [/* optional, structured */]
}
```

Notes:
- Captures use `INSERT OR IGNORE` on the `captures.capture_id` PRIMARY KEY,
  so re-pushing the same batch is idempotent (last-write-wins by
  capture_id; newer rows from a fresh sync simply won't overwrite because
  the key collides and the row is preserved).
- PNGs are uploaded to R2 at `captures/{capture_id}.png` and the
  `captures.png_r2_key` column is updated. If the capture row doesn't
  exist yet (e.g. push-as-PNG-only retry), a stub row is inserted first.
- Large batches are chunked at 50 statements/call into `db.batch()`.

### `POST /sync/pull`

The boat asks the cloud for everything it doesn't have yet.

```jsonc
{ "device_id": "EILEEN", "last_sync": "2026-07-18T12:00:00Z" }
```

Response:
```jsonc
{
  "sync_id":        "uuid",
  "server_time":    "2026-07-18T18:55:00Z",
  "last_sync":      "2026-07-18T12:00:00Z",
  "weather_log":     [/* rows from weather_log */],
  "narrator_reports":[/* sessions where domain='narrator' */],
  "training_prompts":[/* training_labels where label_type='cloud_prompt' */],
  "a2a_messages":    [/* a2a_messages where receiver is NULL/blank/EILEEN */],
  "counts": { "weather_log": 12, "narrator_reports": 1, "training_prompts": 3, "a2a_messages": 4 }
}
```

The "narrator_reports" view is derived from `sessions` rows where
`domain='narrator'` — that's how the narrator worker currently writes its
output. If the narrator later writes to a dedicated table, swap the
query; the response shape stays the same.

### `GET /sync/status`

Returns KV-tracked sync state plus cheap D1 counts.

### `POST /sync/r2-upload`

Single-shot PNG upload. Useful for retry-after-failure backfills.

```jsonc
{ "capture_id": "1240_...", "base64": "iVBOR..." }
```

Returns `{ capture_id, r2_key, size }` or `{ error }`.

## Conflict resolution

| Asset            | Strategy                                                                          |
| ---------------- | --------------------------------------------------------------------------------- |
| `captures`       | `INSERT OR IGNORE` on `capture_id` (PK). Last-write-wins = first-write-wins, since updates require an explicit UPDATE. Boats don't UPDATE captures — they're append-only. |
| `sessions`       | `INSERT OR IGNORE` on `id` (PK). Same idempotency semantics.                       |
| `observations`   | `INSERT OR IGNORE` with auto-incrementing ID. Boat is responsible for not re-sending. |
| `catch_labels`   | Same as observations. Capture-id linkage is informational only.                   |
| `weather_log`    | Server-authoritative; never pushed by the boat.                                   |
| `a2a_messages`   | Server-authoritative push via pull.                                               |
| `training_labels`| `INSERT OR IGNORE` on `id` (PK). Cloud pushes `label_type='cloud_prompt'` rows; boat echoes back confirmations/corrections. Both ends filter on `label_type`. |
| Sync state (KV)  | Last writer wins. Concurrent pushes from the same device could race — the worst case is a slight over-count on `pushed_count`. Acceptable for now. |

## Deployment

This worker is part of the same monorepo as `fleet-gateway` and shares the
`fleet-data` D1. Deploy as a standalone worker (it has its own routes in
`wrangler.toml`) or behind the gateway.

```sh
cd workers/sync
wrangler d1 create fleet-data         # if not already created
wrangler kv namespace create SYNC_STATE
wrangler r2 bucket create fleet-echograms
# paste the IDs into wrangler.toml (replace "placeholder")
wrangler deploy
```

## Local dev

`wrangler dev` provides a local runtime with all bindings mocked via
Miniflare. Endpoints behave identically.
