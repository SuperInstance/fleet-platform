#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Fleet Platform — One-command deploy for the whole agency
# ═══════════════════════════════════════════════════════════
set -e

ACCOUNT=${CLOUDFLARE_ACCOUNT_ID:-""}
TOKEN=${CLOUDFLARE_API_TOKEN:-""}

if [ -z "$TOKEN" ]; then
  echo "❌ Set CLOUDFLARE_API_TOKEN first:"
  echo "   export CLOUDFLARE_API_TOKEN='your-token'"
  exit 1
fi

echo "🚀 Deploying Fleet Platform..."
echo ""

# ── 1. Create D1 databases ─────────────────────────────────
echo "📦 Creating D1 databases..."

DB_FLEET=$(npx wrangler d1 create fleet-data 2>&1 | grep "database_id" | cut -d'"' -f4 || echo "")
DB_SESSIONS=$(npx wrangler d1 create activelog-sessions 2>&1 | grep "database_id" | cut -d'"' -f4 || echo "")

echo "   fleet-data: $DB_FLEET"
echo "   activelog-sessions: $DB_SESSIONS"

# ── 2. Create KV namespaces ────────────────────────────────
echo "📦 Creating KV namespaces..."
KV_WEATHER=$(npx wrangler kv namespace create CACHE 2>&1 | grep "id" | cut -d'"' -f4 || echo "")
KV_A2A=$(npx wrangler kv namespace create A2A_STATE 2>&1 | grep "id" | cut -d'"' -f4 || echo "")

# ── 3. Create Vectorize index ──────────────────────────────
echo "📦 Creating Vectorize index..."
npx wrangler vectorize create fleet-embeddings --dimensions=384 2>/dev/null || echo "   (may already exist)"

# ── 4. Create R2 bucket ────────────────────────────────────
echo "📦 Creating R2 bucket..."
npx wrangler r2 bucket create fleet-media 2>/dev/null || echo "   (may already exist)"

# ── 5. Run migrations ──────────────────────────────────────
echo "📦 Running migrations..."
npx wrangler d1 execute fleet-data --file=schema/fleet.sql 2>/dev/null || true
npx wrangler d1 execute activelog-sessions --file=schema/sessions.sql 2>/dev/null || true

# ── 6. Deploy workers ──────────────────────────────────────
echo "🚀 Deploying Workers..."

for worker in workers/*/; do
  name=$(basename $worker)
  echo "   deploying $name..."
  cd "$worker"
  npx wrangler deploy 2>/dev/null && echo "   ✅ $name" || echo "   ⚠ $name (check wrangler.toml IDs)"
  cd ../..
done

# ── 7. Deploy dashboard ────────────────────────────────────
echo "🚀 Deploying dashboard..."
cd dashboard
npx wrangler pages deploy . --project-name=fleet-dashboard 2>/dev/null && echo "✅ dashboard" || echo "⚠ dashboard"
cd ..

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ Fleet Platform deployed!"
echo ""
echo "Next steps:"
echo "  1. Point *.superinstance.ai DNS to workers (if not auto)"
echo "  2. Set up cron triggers in Cloudflare dashboard"
echo "  3. Open the fleet dashboard to verify all services"
echo "═══════════════════════════════════════════════════════"
