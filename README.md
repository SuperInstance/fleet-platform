# Fleet Platform

> One-command deploy for the SuperInstance agency cloud infrastructure.
> OracleClaw builds Cloudflare tools. This is the control panel.

## Quick Deploy

```bash
export CLOUDFLARE_API_TOKEN='your-token'
cd fleet-platform
chmod +x deploy/deploy.sh
./deploy/deploy.sh
```

That creates:
- 2 D1 databases (fleet-data, activelog-sessions)
- 2 KV namespaces (CACHE, A2A_STATE)
- 1 Vectorize index (fleet-embeddings, 384-dim)
- 1 R2 bucket (fleet-media)
- All Workers deployed
- Dashboard live on Pages

## What's Included

### Workers

| Worker | Route | Purpose |
|--------|-------|---------|
| **fleet-gateway** | `api.fleet.superinstance.ai` | Single API for all agency data |
| **fleet-weather** | `weather.superinstance.ai` | Marine weather proxy + hourly cron |

### Gateway API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Fleet health check |
| `/stats` | GET | Counts of all data |
| `/sessions` | GET/POST | ActiveLog sessions |
| `/captures` | GET/POST | Echogram captures from boat |
| `/training-labels` | GET/POST | Narrator training data |
| `/a2a/messages` | GET/POST | Polyformalism A2A intent messages |
| `/search?q=` | GET | Semantic search (Vectorize) |
| `/brief` | GET | Morning brief aggregation |
| `/vessel/position` | GET | Last known vessel position |
| `/weather/ingest` | POST | Store vessel observation |
| `/catch` | POST | Record catch label |

### Dashboard

Live at `fleet.superinstance.ai` (Pages). Shows all services, agent directory, repository links, and live stats.

### D1 Schema

Single `fleet-data` database with tables:
- `sessions` — ActiveLog transcripts
- `annotations` — timestamp + GPS points
- `weather_log` — hourly weather injection
- `observations` — vessel telemetry
- `captures` — echogram capture mirror
- `catch_labels` — catch reports
- `training_labels` — narrator feedback loop
- `a2a_messages` — polyformalism intent messages
- `fleet_health` — service monitoring

## The Agency

| Agent | Position | Model |
|-------|----------|-------|
| **OracleClaw** | Cloud (24/7) | GLM-5.2 |
| **Hermes** | Nav computer | Local |
| **TZ-Pro** | Nav computer | Python/OpenCV |
| **ActiveLog** | Phone/tablet | Web Speech API |

All communicate through the fleet gateway API using polyformalism A2A intent vectors.

## License

MIT
