export function buildRuntimeMaps(cfg) {
  const chatMap = {};
  const imageMap = {};
  const multipartSet = new Set();
  const visionSet = new Set();
  const sttMap = {};
  const ttsMap = {};
  const embeddingMap = {};
  const translationMap = {};
  const aliasMap = {};
  let moderationModel = null;
  let inpaintingModel = null;

  const contextMap = {};
  for (const m of cfg.chatModels || []) {
    chatMap[m.id] = m.path;
    chatMap[m.path] = m.path;
    if (m.vision) visionSet.add(m.path);
    if (m.contextWindow) contextMap[m.path] = m.contextWindow;
  }
  const imageList = [];
  const maxDimMap = {};
  for (const m of cfg.imageModels || []) {
    imageMap[m.id] = m.path;
    imageMap[m.path] = m.path;
    if (!m.inpainting) imageList.push(m.path);
    if (m.multipart) multipartSet.add(m.path);
    if (m.inpainting && !inpaintingModel) inpaintingModel = m.path;
    if (m.maxDim) maxDimMap[m.path] = m.maxDim;
  }
  for (const m of cfg.voiceModels || []) {
    if (m.kind === "stt") { sttMap[m.id] = m.path; sttMap[m.path] = m.path; }
    if (m.kind === "tts") { ttsMap[m.id] = m.path; ttsMap[m.path] = m.path; }
  }
  for (const m of cfg.utilityModels || []) {
    if (m.kind === "embedding") { embeddingMap[m.id] = m.path; embeddingMap[m.path] = m.path; }
    if (m.kind === "translation") { translationMap[m.id] = m.path; translationMap[m.path] = m.path; }
    if (m.kind === "moderation" && !moderationModel) moderationModel = m.path;
  }

  const modelIdToPath = {};
  for (const list of [cfg.chatModels, cfg.imageModels, cfg.voiceModels, cfg.utilityModels]) {
    for (const m of list || []) { modelIdToPath[m.id] = m.path; }
  }
  for (const a of cfg.aliases || []) {
    const targetPath = modelIdToPath[a.target];
    if (targetPath) aliasMap[a.name] = targetPath;
  }

  return { chatMap, imageMap, imageList, multipartSet, maxDimMap, visionSet, contextMap, sttMap, ttsMap, embeddingMap, translationMap, moderationModel, inpaintingModel, aliasMap };
}

export const DEFAULT_CONFIG = {
  chatModels: [],
  imageModels: [],
  voiceModels: [],
  utilityModels: [],
  aliases: [],
  spoofedKeys: [],
  keyNames: {},
  rateLimits: { admin: 120, client: 60 },
};

export const STARTER_CONFIG = {
  imageModels: [
    { id: "flux-2-klein-4b", path: "@cf/black-forest-labs/flux-2-klein-4b", multipart: true, maxDim: 1920, label: "Flux 2 Klein 4B" },
    { id: "flux-1-schnell", path: "@cf/black-forest-labs/flux-1-schnell", multipart: false, maxDim: 1024, label: "Flux 1 Schnell" },
    { id: "phoenix-1.0", path: "@cf/leonardo/phoenix-1.0", multipart: false, maxDim: 2048, label: "Leonardo Phoenix 1.0" },
    { id: "sd-v1-5-inpainting", path: "@cf/runwayml/stable-diffusion-v1-5-inpainting", multipart: false, maxDim: 512, label: "SD 1.5 Inpainting", inpainting: true },
  ],
  chatModels: [
    { id: "qwen3-30b-a3b-fp8", path: "@cf/qwen/qwen3-30b-a3b-fp8", label: "Qwen3 30B", vision: false, contextWindow: 32768 },
    { id: "qwen2.5-coder-32b-instruct", path: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B", vision: false, contextWindow: 32768 },
    { id: "glm-4.7-flash", path: "@cf/zai-org/glm-4.7-flash", label: "GLM 4.7 Flash", vision: false, contextWindow: 131072 },
    { id: "gpt-oss-20b", path: "@cf/openai/gpt-oss-20b", label: "GPT-OSS 20B", vision: false, contextWindow: 128000 },
    { id: "gpt-oss-120b", path: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B", vision: false, contextWindow: 128000 },
    { id: "llama-4-scout-17b-16e-instruct", path: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B", vision: true, contextWindow: 131072 },
  ],
  voiceModels: [
    { id: "whisper-large-v3-turbo", path: "@cf/openai/whisper-large-v3-turbo", label: "Whisper v3 Turbo", kind: "stt" },
    { id: "aura-2-en", path: "@cf/deepgram/aura-2-en", label: "Aura 2 EN", kind: "tts" },
    { id: "aura-2-es", path: "@cf/deepgram/aura-2-es", label: "Aura 2 ES", kind: "tts" },
    { id: "melotts", path: "@cf/myshell-ai/melotts", label: "MeloTTS", kind: "tts" },
  ],
  utilityModels: [
    { id: "bge-m3", path: "@cf/baai/bge-m3", label: "BGE-M3", kind: "embedding" },
    { id: "bge-large-en-v1.5", path: "@cf/baai/bge-large-en-v1.5", label: "BGE Large EN", kind: "embedding" },
    { id: "m2m100-1.2b", path: "@cf/meta/m2m100-1.2b", label: "M2M100 1.2B", kind: "translation" },
    { id: "llama-guard-3-8b", path: "@cf/meta/llama-guard-3-8b", label: "Llama Guard 3", kind: "moderation" },
  ],
  aliases: [
    { name: "gpt-4o", target: "qwen3-30b-a3b-fp8", type: "chat" },
    { name: "gpt-4o-mini", target: "qwen3-30b-a3b-fp8", type: "chat" },
    { name: "gpt-4-turbo", target: "qwen3-30b-a3b-fp8", type: "chat" },
    { name: "gpt-3.5-turbo", target: "glm-4.7-flash", type: "chat" },
    { name: "dall-e-3", target: "flux-2-klein-4b", type: "image" },
    { name: "dall-e-2", target: "flux-1-schnell", type: "image" },
    { name: "whisper-1", target: "whisper-large-v3-turbo", type: "voice" },
    { name: "tts-1", target: "aura-2-en", type: "voice" },
    { name: "tts-1-hd", target: "aura-2-en", type: "voice" },
  ],
  spoofedKeys: [],
  keyNames: {},
};

let _cfgCache = null;
let _cfgCacheTime = 0;
let _rtCache = null;

export function setConfigCache(cfg) {
  _cfgCache = cfg;
  _cfgCacheTime = Date.now();
  _rtCache = null;
}

export function getRuntimeMaps(cfg) {
  if (_rtCache && _cfgCache === cfg) return _rtCache;
  _rtCache = buildRuntimeMaps(cfg);
  return _rtCache;
}

function cloneConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

function parseEnvConfig(env) {
  if (!env.GATEWAY_CONFIG) return null;
  try { return JSON.parse(env.GATEWAY_CONFIG); } catch { return null; }
}

export async function loadConfig(env, skipCache) {
  const now = Date.now();
  if (!skipCache && _cfgCache && now - _cfgCacheTime < 5000) return cloneConfig(_cfgCache);
  if (!env.CONFIG) {
    if (_cfgCache) return cloneConfig(_cfgCache);
    const envCfg = parseEnvConfig(env);
    _cfgCache = envCfg ? { ...DEFAULT_CONFIG, ...envCfg } : { ...DEFAULT_CONFIG };
    delete _cfgCache.publicStatus;
    _cfgCacheTime = now;
    return cloneConfig(_cfgCache);
  }
  const raw = await env.CONFIG.get("gateway-config", "json").catch(() => null);
  _cfgCache = raw ? { ...DEFAULT_CONFIG, ...raw } : { ...DEFAULT_CONFIG };
  delete _cfgCache.publicStatus;
  _cfgCacheTime = now;
  return cloneConfig(_cfgCache);
}

export async function handleGetConfig(env) {
  const cfg = await loadConfig(env);
  const safe = { ...cfg, _meta: { kv: !!env.CONFIG } };
  if (safe.users) {
    safe.users = safe.users.map(u => ({
      id: u.id,
      keyPreview: u.keyPreview,
      created: u.created,
      role: u.role || "client",
    }));
  }
  return Response.json(safe);
}

export async function handleSaveConfig(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  delete body.publicStatus;
  const prev = await loadConfig(env, true);
  body.users = prev.users || [];
  body.spoofedKeys = prev.spoofedKeys || [];
  body.keyNames = prev.keyNames || {};
  if (env.CONFIG) {
    try {
      await env.CONFIG.put("gateway-config", JSON.stringify(body));
    } catch {
      return Response.json({ error: "Failed to persist config" }, { status: 503 });
    }
    setConfigCache(body);
    return Response.json({ ok: true, storage: "kv" });
  } else {
    setConfigCache(body);
    return Response.json({ ok: true, storage: "memory" });
  }
}
