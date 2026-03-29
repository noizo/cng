# CNG · Cloudflare Neuron Gate

OpenAI-compatible API gateway running on Cloudflare Workers AI. Single file, zero dependencies. Proxies chat, image, audio, embedding, and moderation requests to Workers AI models behind a standard OpenAI API interface.

```
Client (OpenAI SDK / curl / any app)
  │
  ▼
CNG Worker  ←──  OpenAI-compatible API
  │
  ▼
Cloudflare Workers AI  ←──  Qwen, Flux, Whisper, Deepgram, Llama Guard ...
```

## What it does

- **Chat completions** — streaming and non-streaming, tool calls, vision
- **Image generation** — Flux 2, Flux 1, Leonardo Phoenix, SDXL Lightning
- **Image editing** — SD v1.5 inpainting
- **Audio transcription & translation** — Whisper v3 Turbo
- **Text-to-speech** — Deepgram Aura 2, MeloTTS
- **Embeddings** — BGE-M3
- **Content moderation** — Llama Guard 3
- **Text translation** — M2M100
- **Model aliasing** — per-user toggle to map `gpt-4o` → `qwen3-30b-a3b-fp8`, `dall-e-3` → `flux-2-klein-4b`, etc.
- **Config panel** — web UI for models, aliases, users, live cost tracking, model discovery
- **ASCII status** — `curl /status` for terminal dashboards
- **Multi-key auth** — per-key rate limits, KV-backed user management
- **Dual mode** — works on free tier (in-memory) or paid (KV-persistent)

## Quick start

### Option A: Setup script (recommended)

```bash
git clone https://github.com/noizo/cng.git
cd cng
./setup.sh
```

The script walks you through everything: account ID, API token, key generation, optional KV, and deployment.

**Prerequisites:** [Node.js](https://nodejs.org/) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

```bash
npm install -g wrangler
wrangler login
```

### Option B: Manual (wrangler)

```bash
# 1. Clone the repo
git clone https://github.com/noizo/cng.git
cd cng

# 2. Edit wrangler.toml — set worker name
#    Optionally uncomment KV section

# 3. Deploy
wrangler deploy

# 4. Set secrets
echo "<your-cloudflare-account-id>" | wrangler secret put CF_ACCOUNT_ID
echo "<your-cloudflare-api-token>"  | wrangler secret put CF_API_TOKEN
echo "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" | wrangler secret put API_KEY

# 5. (Optional) Second API key
echo "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" | wrangler secret put API_KEY_2
```

### Option C: Terraform (infrastructure-as-code)

For teams or reproducible deployments:

```hcl
resource "cloudflare_workers_script" "cng" {
  account_id  = var.cloudflare_account_id
  script_name = "cng"
  content     = file("${path.module}/index.js")
  module      = true

  bindings {
    name = "CF_ACCOUNT_ID"
    text = var.cloudflare_account_id
    type = "plain_text"
  }
  bindings {
    name = "CF_API_TOKEN"
    text = var.cloudflare_api_token
    type = "secret_text"
  }
  bindings {
    name = "API_KEY"
    text = var.api_key
    type = "secret_text"
  }
  # Optional: KV for persistent config
  # bindings {
  #   name         = "CONFIG"
  #   namespace_id = cloudflare_workers_kv_namespace.cng.id
  #   type         = "kv_namespace"
  # }
}
```

## Secrets & environment

| Secret | Required | Description |
|--------|----------|-------------|
| `CF_ACCOUNT_ID` | Yes | Cloudflare account ID |
| `CF_API_TOKEN` | Yes | API token — needs **Workers AI (Read)** + **Account Analytics (Read)** |
| `API_KEY` | Yes | Primary gateway API key |
| `API_KEY_2` | No | Secondary API key (additional keys can also be created via config panel) |

| Binding | Required | Description |
|---------|----------|-------------|
| `CONFIG` (KV) | No | KV namespace for persistent config. Without it, everything works but config resets on cold start |

### Creating the API token

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create Custom Token with:
   - **Account → Workers AI → Read**
   - **Account → Account Analytics → Read**
   - **Account → Workers KV Storage → Edit** *(only if using KV)*

## Usage

### Base URL

```
https://<worker-name>.<subdomain>.workers.dev/v1
```

Or your custom domain if configured.

### Authentication

```
Authorization: Bearer <your-api-key>
```

### Model selection

Three ways to specify a model:

```bash
# Short name (auto-derived from path)
curl ... -d '{"model": "qwen3-30b-a3b-fp8", ...}'

# Full Cloudflare path
curl ... -d '{"model": "@cf/qwen/qwen3-30b-a3b-fp8", ...}'

# Alias (if configured)
curl ... -d '{"model": "gpt-4o", ...}'
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat (streaming supported) |
| `POST` | `/v1/images/generations` | Image generation |
| `POST` | `/v1/images/edits` | Image inpainting (multipart) |
| `POST` | `/v1/embeddings` | Text embeddings |
| `POST` | `/v1/audio/transcriptions` | Speech-to-text (multipart) |
| `POST` | `/v1/audio/translations` | Speech translation (multipart) |
| `POST` | `/v1/audio/speech` | Text-to-speech |
| `POST` | `/v1/translations` | Text translation |
| `POST` | `/v1/moderations` | Content moderation |
| `GET` | `/v1/models` | List available models |
| `GET` | `/status` | ASCII status dashboard |
| `GET` | `/config?key=<key>` | Web config panel |
| `GET` | `/api/discover` | Browse Cloudflare model catalog |

### Examples

**Chat:**

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-30b-a3b-fp8",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

**Image generation:**

```bash
curl https://your-worker.workers.dev/v1/images/generations \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "flux-2-klein-4b",
    "prompt": "A mountain at sunset",
    "size": "1920x1080"
  }'
```

**Transcription:**

```bash
curl https://your-worker.workers.dev/v1/audio/transcriptions \
  -H "Authorization: Bearer $KEY" \
  -F file=@audio.mp3 \
  -F model=whisper-large-v3-turbo
```

**Text-to-speech:**

```bash
curl https://your-worker.workers.dev/v1/audio/speech \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "aura-2-en", "input": "Hello world"}' \
  --output speech.mp3
```

**Status dashboard:**

```bash
curl -H "Authorization: Bearer $KEY" https://your-worker.workers.dev/status
```

```
╭────────────────────────────────────────────────╮
│          Cloudflare Neuron Gate                 │
│                                                │
│        ○                                       │
│        │                                       │
│      ╱───╲                                     │
│    ╱  ● ●  ╲    CNG                            │
│    ╲   ◠   ╱    2026-03-29 12:00 UTC           │
│      ╲───╱                                     │
├────────────────────────────────────────────────┤
│ Neurons   1.2k / 10k         8.8k left   $0.00│
│   █████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│                                                │
├────────────────────────────────────────────────┤
│ Model                Reqs   Neurons       ms   │
│ ─────────────────────────────────────────────  │
│ qwen3-30b-a3b-fp8     15      800      1.2k   │
│ flux-2-klein-4b        3      400      2.5k   │
╰────────────────────────────────────────────────╯
```

## Config panel

Access at `https://your-worker/config?key=<your-api-key>`

Manage models (enable/disable, reorder, add/remove), users, aliases, live cost tracking, and export config JSON. The **Discover Models** button queries the Cloudflare Workers AI catalog and lets you add new models with one click, complete with capability badges and pricing info.

### With vs without KV

| | Free tier (no KV) | Paid ($5/mo with KV) |
|---|---|---|
| Gateway routing | Works | Works |
| Config panel | Works | Works |
| Config changes | In-memory, lost on cold start | Persistent in KV |
| User management | In-memory | Persistent |
| Export JSON | Yes | Yes |
| Import via wrangler | Yes | N/A (panel saves directly) |

To persist config without KV, use the Export JSON button, then:

```bash
wrangler kv key put --namespace-id=<id> gateway-config --path=cng-config.json
```

## OpenAI SDK compatibility

Works with any OpenAI-compatible client:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-worker.workers.dev/v1",
    api_key="your-api-key",
)

response = client.chat.completions.create(
    model="qwen3-30b-a3b-fp8",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://your-worker.workers.dev/v1',
  apiKey: 'your-api-key',
});

const response = await client.chat.completions.create({
  model: 'qwen3-30b-a3b-fp8',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

## Costs

Cloudflare Workers AI uses **neurons** as the billing unit.

| Tier | Included | Overage |
|------|----------|---------|
| Free | 10,000 neurons/day | Not available |
| Paid ($5/mo) | 10,000 neurons/day | $0.011 per 1,000 neurons |

The `/status` endpoint and config panel show real-time neuron usage and cost projections.

## Security notes

- API keys are compared with timing-safe equality checks
- KV user key hashes use SHA-256; raw keys are shown only once on creation
- The `/api/config` endpoint strips sensitive fields (key hashes) from responses
- All user-controlled strings in the config UI are HTML-escaped and JS-context-escaped
- The config panel is single-tenant: any valid key can modify configuration. For multi-tenant use, consider splitting admin/client keys

## Roadmap / nice to have

- **WebSocket audio streaming** — real-time STT/TTS via WebSocket proxy for models like Deepgram Nova 3
- **Auto-sync pricing** — CF model search API doesn't expose pricing for all models; a periodic scrape or cache of the CF docs pricing table could fill the gaps
- **Config versioning** — KV-backed config history / rollback
- **Admin role separation** — separate admin key for config/user management vs regular API keys

## License

MIT
