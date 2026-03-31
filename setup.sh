#!/usr/bin/env bash
set -euo pipefail

# CNG · Cloudflare Neuron Gate — Setup Script
# Works both ways:
#   From repo:  git clone … && cd cng && ./setup.sh
#   Remote:     curl -fsSL https://raw.githubusercontent.com/noizo/cng/main/setup.sh | bash

CYAN='\033[0;36m' GREEN='\033[0;32m' YELLOW='\033[0;33m'
RED='\033[0;31m' BOLD='\033[1m' NC='\033[0m'

info()  { printf "${CYAN}→${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${NC} %s\n" "$*"; }
err()   { printf "${RED}✗${NC} %s\n" "$*" >&2; }
ask()   { printf "${BOLD}? %s${NC} " "$1"; }

gen_key() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '='; }

RELEASE_URL="https://github.com/noizo/cng/releases/latest/download/cng.js"
FROM_SOURCE=false
CLEANUP=""

cat <<'BANNER'
   ┌─────┐
   │ • • │   CNG · Cloudflare Neuron Gate
   │  ◡  │   Setup
   └──┬──┘
      │
BANNER

# ── Detect mode ───────────────────────────────────────────────

if [[ -f "src/index.js" && -f "src/config.js" ]]; then
  FROM_SOURCE=true
  ok "Running from source"
else
  info "Downloading latest CNG bundle..."
  WORKDIR=$(mktemp -d)
  CLEANUP="$WORKDIR"
  trap 'rm -rf "$CLEANUP"' EXIT
  cd "$WORKDIR"

  if ! curl -fsSL -o cng.js "$RELEASE_URL"; then
    err "Failed to download bundle from $RELEASE_URL"
    info "Alternative: git clone https://github.com/noizo/cng.git && cd cng && ./setup.sh"
    exit 1
  fi
  ok "Bundle downloaded ($(wc -c < cng.js | tr -d ' ') bytes)"
fi

# ── Prerequisites ──────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  err "Node.js not found"
  info "Install from: https://nodejs.org/"
  exit 1
fi
ok "Node.js $(node --version)"

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
info "Generating API keys..."
API_KEY=$(gen_key)
ok "Admin key (API_KEY): ${API_KEY}"

ask "Generate a client key (API_KEY_2)? Inference only, no config access [y/N]:"
read -r ADD_SECOND
KEY2=""
if [[ "${ADD_SECOND,,}" == "y" ]]; then
  KEY2=$(gen_key)
  ok "Client key (API_KEY_2): ${KEY2}"
fi

# ── CF API Token ───────────────────────────────────────────────

echo ""
info "CNG needs a Cloudflare API token with these permissions:"
echo "    • Account → Workers AI → Read + Edit"
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

# ── Starter models ────────────────────────────────────────────

echo ""
ask "Start with a curated model catalog? (recommended for first-time users) [Y/n]:"
read -r USE_STARTER
USE_STARTER="${USE_STARTER:-y}"

# ── Generate wrangler.toml ─────────────────────────────────────

info "Writing wrangler.toml..."

if $FROM_SOURCE; then
  cat > wrangler.toml <<EOF
name = "${WORKER_NAME}"
main = "src/index.js"
compatibility_date = "2024-12-01"

[[rules]]
globs = ["**/*.html"]
type = "Text"
fallthrough = true

[ai]
binding = "AI"
EOF
else
  cat > wrangler.toml <<EOF
name = "${WORKER_NAME}"
main = "cng.js"
compatibility_date = "2024-12-01"

[ai]
binding = "AI"
EOF
fi

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

# ── Starter config ────────────────────────────────────────────

if [[ "${USE_STARTER,,}" == "y" ]]; then
  info "Loading starter model catalog..."
  STARTER_JSON=""

  if $FROM_SOURCE; then
    STARTER_JSON=$(node -e "
      import { STARTER_CONFIG } from './src/config.js';
      console.log(JSON.stringify(STARTER_CONFIG));
    " 2>/dev/null || echo "")
  fi

  if [[ -z "$STARTER_JSON" ]]; then
    STARTER_JSON='{"chatModels":[{"id":"qwen3-30b-a3b-fp8","path":"@cf/qwen/qwen3-30b-a3b-fp8","label":"Qwen3 30B","vision":false,"contextWindow":32768},{"id":"qwen2.5-coder-32b-instruct","path":"@cf/qwen/qwen2.5-coder-32b-instruct","label":"Qwen 2.5 Coder 32B","vision":false,"contextWindow":32768},{"id":"glm-4.7-flash","path":"@cf/zai-org/glm-4.7-flash","label":"GLM 4.7 Flash","vision":false,"contextWindow":131072},{"id":"gpt-oss-20b","path":"@cf/openai/gpt-oss-20b","label":"GPT-OSS 20B","vision":false,"contextWindow":128000},{"id":"gpt-oss-120b","path":"@cf/openai/gpt-oss-120b","label":"GPT-OSS 120B","vision":false,"contextWindow":128000},{"id":"llama-4-scout-17b-16e-instruct","path":"@cf/meta/llama-4-scout-17b-16e-instruct","label":"Llama 4 Scout 17B","vision":true,"contextWindow":131072}],"imageModels":[{"id":"flux-2-klein-4b","path":"@cf/black-forest-labs/flux-2-klein-4b","multipart":true,"maxDim":1920,"label":"Flux 2 Klein 4B"},{"id":"flux-1-schnell","path":"@cf/black-forest-labs/flux-1-schnell","multipart":false,"maxDim":1024,"label":"Flux 1 Schnell"},{"id":"phoenix-1.0","path":"@cf/leonardo/phoenix-1.0","multipart":false,"maxDim":2048,"label":"Leonardo Phoenix 1.0"},{"id":"sd-v1-5-inpainting","path":"@cf/runwayml/stable-diffusion-v1-5-inpainting","multipart":false,"maxDim":512,"label":"SD 1.5 Inpainting","inpainting":true}],"voiceModels":[{"id":"whisper-large-v3-turbo","path":"@cf/openai/whisper-large-v3-turbo","label":"Whisper v3 Turbo","kind":"stt"},{"id":"aura-2-en","path":"@cf/deepgram/aura-2-en","label":"Aura 2 EN","kind":"tts"},{"id":"aura-2-es","path":"@cf/deepgram/aura-2-es","label":"Aura 2 ES","kind":"tts"},{"id":"melotts","path":"@cf/myshell-ai/melotts","label":"MeloTTS","kind":"tts"}],"utilityModels":[{"id":"bge-m3","path":"@cf/baai/bge-m3","label":"BGE-M3","kind":"embedding"},{"id":"bge-large-en-v1.5","path":"@cf/baai/bge-large-en-v1.5","label":"BGE Large EN","kind":"embedding"},{"id":"m2m100-1.2b","path":"@cf/meta/m2m100-1.2b","label":"M2M100 1.2B","kind":"translation"},{"id":"llama-guard-3-8b","path":"@cf/meta/llama-guard-3-8b","label":"Llama Guard 3","kind":"moderation"}],"aliases":[{"name":"gpt-4o","target":"qwen3-30b-a3b-fp8","type":"chat"},{"name":"gpt-4o-mini","target":"qwen3-30b-a3b-fp8","type":"chat"},{"name":"gpt-4-turbo","target":"qwen3-30b-a3b-fp8","type":"chat"},{"name":"gpt-3.5-turbo","target":"glm-4.7-flash","type":"chat"},{"name":"dall-e-3","target":"flux-2-klein-4b","type":"image"},{"name":"dall-e-2","target":"flux-1-schnell","type":"image"},{"name":"whisper-1","target":"whisper-large-v3-turbo","type":"voice"},{"name":"tts-1","target":"aura-2-en","type":"voice"},{"name":"tts-1-hd","target":"aura-2-en","type":"voice"}],"spoofedKeys":[],"keyNames":{}}'
  fi

  if [[ -n "$KV_ID" ]]; then
    echo "$STARTER_JSON" | wrangler kv key put "gateway-config" --namespace-id="$KV_ID" --stdin
    ok "Starter models saved to KV"
  else
    echo "$STARTER_JSON" | wrangler secret put GATEWAY_CONFIG
    ok "Starter models saved as GATEWAY_CONFIG secret"
  fi
else
  info "Starting fresh — open the config panel to add models via discovery"
fi

# ── Done ───────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "CNG deployed!"
echo ""
echo "  Worker:      ${WORKER_NAME}"
echo "  Admin key:   ${API_KEY}  (full access)"
[[ -n "$KEY2" ]] && echo "  Client key:  ${KEY2}  (inference only)"
[[ -n "$KV_ID" ]]    && echo "  KV:          ${KV_ID}"
echo ""
echo "  ${BOLD}Config panel:${NC}"
echo "    https://${WORKER_NAME}.<subdomain>.workers.dev/config"
echo ""
echo "  ${BOLD}Test:${NC}"
echo "    curl -H 'Authorization: Bearer ${API_KEY}' \\"
echo "      https://${WORKER_NAME}.<subdomain>.workers.dev/v1/models"
echo ""
echo "  ${BOLD}Status:${NC}"
echo "    curl -H 'Authorization: Bearer ${API_KEY}' \\"
echo "      https://${WORKER_NAME}.<subdomain>.workers.dev/api/status"
echo ""
if [[ -z "$KV_ID" ]]; then
  warn "No KV — config resets on cold start"
  info "Use Export JSON + wrangler secret put GATEWAY_CONFIG to persist settings"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
