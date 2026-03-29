#!/usr/bin/env bash
set -euo pipefail

# CNG · Cloudflare Neuron Gate — Setup Script
# Deploys an OpenAI-compatible API gateway on Cloudflare Workers AI

CYAN='\033[0;36m' GREEN='\033[0;32m' YELLOW='\033[0;33m'
RED='\033[0;31m' BOLD='\033[1m' NC='\033[0m'

info()  { printf "${CYAN}→${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${NC} %s\n" "$*"; }
err()   { printf "${RED}✗${NC} %s\n" "$*" >&2; }
ask()   { printf "${BOLD}? %s${NC} " "$1"; }

gen_key() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '='; }

cat <<'BANNER'
   ┌─────┐
   │ • • │   CNG · Cloudflare Neuron Gate
   │  ◡  │   Setup Script
   └──┬──┘
      │
BANNER

# ── Prerequisites ──────────────────────────────────────────────

if ! command -v wrangler &>/dev/null; then
  err "wrangler CLI not found"
  info "Install: npm install -g wrangler"
  info "Then:    wrangler login"
  exit 1
fi
ok "wrangler found: $(wrangler --version 2>/dev/null | head -1)"

if ! wrangler whoami &>/dev/null 2>&1; then
  warn "Not logged in to Cloudflare"
  info "Running: wrangler login"
  wrangler login
fi
ok "Authenticated with Cloudflare"

# ── Gather info ────────────────────────────────────────────────

echo ""
info "Gathering configuration..."
echo ""

ask "Cloudflare Account ID (from dashboard.cloudflare.com):"
read -r CF_ACCOUNT_ID
if [[ -z "$CF_ACCOUNT_ID" ]]; then
  err "Account ID is required"; exit 1
fi

ask "Worker name [cng]:"
read -r WORKER_NAME
WORKER_NAME="${WORKER_NAME:-cng}"

echo ""
info "Generating API key..."
API_KEY=$(gen_key)
ok "Primary key: ${API_KEY}"

ask "Generate a second API key? [y/N]:"
read -r ADD_SECOND
KEY2=""
if [[ "${ADD_SECOND,,}" == "y" ]]; then
  KEY2=$(gen_key)
  ok "Secondary key: ${KEY2}"
fi

# ── CF API Token ───────────────────────────────────────────────

echo ""
info "CNG needs a Cloudflare API token with these permissions:"
echo "    • Account → Workers AI → Read"
echo "    • Account → Account Analytics → Read"
echo "    • Account → Workers KV Storage → Edit  (if using KV)"
echo ""
info "Create one at: https://dash.cloudflare.com/profile/api-tokens"
echo ""
ask "Cloudflare API Token:"
read -rs CF_API_TOKEN
echo ""
if [[ -z "$CF_API_TOKEN" ]]; then
  err "API token is required"; exit 1
fi

# ── KV namespace (optional) ────────────────────────────────────

echo ""
ask "Create KV namespace for persistent config? (requires paid plan) [y/N]:"
read -r USE_KV
KV_ID=""
if [[ "${USE_KV,,}" == "y" ]]; then
  info "Creating KV namespace '${WORKER_NAME}-config'..."
  KV_OUTPUT=$(wrangler kv namespace create "${WORKER_NAME}-config" 2>&1) || true
  KV_ID=$(echo "$KV_OUTPUT" | grep -oP 'id = "\K[^"]+' || echo "")
  if [[ -z "$KV_ID" ]]; then
    KV_ID=$(echo "$KV_OUTPUT" | grep -oE '[a-f0-9]{32}' | head -1 || echo "")
  fi
  if [[ -n "$KV_ID" ]]; then
    ok "KV namespace created: ${KV_ID}"
  else
    warn "Could not parse KV ID. Create manually:"
    echo "    wrangler kv namespace create ${WORKER_NAME}-config"
    echo "$KV_OUTPUT"
  fi
fi

# ── Generate wrangler.toml ─────────────────────────────────────

info "Writing wrangler.toml..."

cat > wrangler.toml <<EOF
name = "${WORKER_NAME}"
main = "index.js"
compatibility_date = "2024-12-01"
EOF

if [[ -n "$KV_ID" ]]; then
  cat >> wrangler.toml <<EOF

[[kv_namespaces]]
binding = "CONFIG"
id = "${KV_ID}"
EOF
fi

ok "wrangler.toml written"

# ── Deploy ─────────────────────────────────────────────────────

echo ""
info "Deploying worker..."
wrangler deploy

echo ""
info "Setting secrets..."
echo "$CF_ACCOUNT_ID" | wrangler secret put CF_ACCOUNT_ID
echo "$CF_API_TOKEN"  | wrangler secret put CF_API_TOKEN
echo "$API_KEY"       | wrangler secret put API_KEY
if [[ -n "$KEY2" ]]; then
  echo "$KEY2" | wrangler secret put API_KEY_2
fi

# ── Done ───────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "CNG deployed!"
echo ""
echo "  Worker:  ${WORKER_NAME}"
echo "  Key:     ${API_KEY}"
[[ -n "$KEY2" ]] && echo "  Key 2:   ${KEY2}"
[[ -n "$KV_ID" ]]    && echo "  KV:      ${KV_ID}"
echo ""
echo "  ${BOLD}Test:${NC}"
echo "    curl -H 'Authorization: Bearer ${API_KEY}' \\"
echo "      https://${WORKER_NAME}.<subdomain>.workers.dev/v1/models"
echo ""
echo "  ${BOLD}Config panel:${NC}"
echo "    https://${WORKER_NAME}.<subdomain>.workers.dev/config?key=${API_KEY}"
echo ""
echo "  ${BOLD}Status:${NC}"
echo "    curl -H 'Authorization: Bearer ${API_KEY}' \\"
echo "      https://${WORKER_NAME}.<subdomain>.workers.dev/status"
echo ""
if [[ -z "$KV_ID" ]]; then
  warn "No KV — config changes are ephemeral (memory only)"
  echo "    Add KV later: wrangler kv namespace create ${WORKER_NAME}-config"
  echo "    Then update wrangler.toml and redeploy"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
