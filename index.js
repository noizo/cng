function buildRuntimeMaps(cfg) {
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
  for (const m of cfg.imageModels || []) {
    imageMap[m.id] = m.path;
    imageMap[m.path] = m.path;
    if (m.multipart) multipartSet.add(m.path);
    if (m.inpainting && !inpaintingModel) inpaintingModel = m.path;
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
  for (const list of [cfg.chatModels, cfg.imageModels, cfg.voiceModels]) {
    for (const m of list || []) { modelIdToPath[m.id] = m.path; }
  }
  for (const a of cfg.aliases || []) {
    const targetPath = modelIdToPath[a.target];
    if (targetPath) aliasMap[a.name] = targetPath;
  }

  return { chatMap, imageMap, multipartSet, visionSet, contextMap, sttMap, ttsMap, embeddingMap, translationMap, moderationModel, inpaintingModel, aliasMap };
}

const API_KEYS = {
  admin:  { envKey: "API_KEY",   rpm: 60 },
  user1:  { envKey: "API_KEY_2", rpm: 20 },
};

const rateBuckets = new Map();

async function hashKey(key) {
  const data = new TextEncoder().encode(key);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function identifyKey(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const enc = new TextEncoder();
  const a = enc.encode(token);
  for (const [id, cfg] of Object.entries(API_KEYS)) {
    const expected = env[cfg.envKey] || "";
    if (!expected || a.length !== expected.length) continue;
    const b = enc.encode(expected);
    if (crypto.subtle.timingSafeEqual(a, b)) return id;
  }
  if (env.CONFIG) {
    const config = await loadConfig(env);
    if (config.users) {
      const tokenHash = await hashKey(token);
      const enc2 = new TextEncoder();
      for (const user of config.users) {
        const a2 = enc2.encode(tokenHash);
        const b2 = enc2.encode(user.keyHash || "");
        if (a2.length === b2.length && crypto.subtle.timingSafeEqual(a2, b2)) {
          if (!API_KEYS[user.id]) API_KEYS[user.id] = { rpm: user.rpm || 30 };
          return user.id;
        }
      }
    }
  }
  return null;
}

function checkRateLimit(keyId) {
  const cfg = API_KEYS[keyId];
  if (!cfg) return false;
  const now = Date.now();
  const windowMs = 60_000;
  let bucket = rateBuckets.get(keyId);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(keyId, bucket);
  }
  bucket.count++;
  return bucket.count > cfg.rpm;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isGet = request.method === "GET";
    const isPost = request.method === "POST";
    const isModels = url.pathname === "/v1/models" || url.pathname === "/models";

    if (isGet && url.pathname.startsWith("/img/")) {
      return handleServeImage(url);
    }

    if (isGet && url.pathname === "/config") {
      return new Response(CONFIG_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (!isGet && !isPost) {
      return new Response("Method not allowed", { status: 405 });
    }

    const keyId = await identifyKey(request, env);
    if (!keyId) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (checkRateLimit(keyId)) {
      return Response.json(
        { error: { message: "Rate limit exceeded", type: "rate_limit_error" } },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }

    const _cfg = await loadConfig(env);
    const spoofed = (_cfg.spoofedKeys || []).includes(keyId);
    const rt = buildRuntimeMaps(_cfg);

    if (isModels && isGet) return handleListModels(_cfg, spoofed);

    if (isGet && url.pathname === "/api/status") {
      const data = await fetchStatusData(env);
      return Response.json(data);
    }

    if (isGet && url.pathname === "/status") {
      const data = await fetchStatusData(env);
      return new Response(renderAsciiStatus(data), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (isGet && url.pathname === "/api/config") {
      return handleGetConfig(env);
    }

    if (isPost && url.pathname === "/api/config") {
      return handleSaveConfig(request, env);
    }

    if (isGet && url.pathname === "/api/discover") {
      return handleDiscover(env, _cfg);
    }

    if (isGet && url.pathname === "/api/users") {
      return handleGetUsers(env);
    }

    if (isPost && url.pathname === "/api/users") {
      return handleUserAction(request, env);
    }

    if (!isPost) return new Response("Method not allowed", { status: 405 });

    if (url.pathname === "/v1/images/generations" || url.pathname === "/images/generations") {
      return handleImageGeneration(request, env, rt, spoofed);
    }

    if (url.pathname === "/v1/embeddings" || url.pathname === "/embeddings") {
      return handleEmbeddings(request, env, rt);
    }

    if (url.pathname === "/v1/audio/transcriptions" || url.pathname === "/audio/transcriptions") {
      return handleAudioTranscription(request, env, rt);
    }

    if (url.pathname === "/v1/audio/translations" || url.pathname === "/audio/translations") {
      return handleAudioTranslation(request, env, rt);
    }

    if (url.pathname === "/v1/audio/speech" || url.pathname === "/audio/speech") {
      return handleAudioSpeech(request, env, rt);
    }

    if (url.pathname === "/v1/images/edits" || url.pathname === "/images/edits") {
      return handleImageEdits(request, env, rt, spoofed);
    }

    if (url.pathname === "/v1/moderations" || url.pathname === "/moderations") {
      return handleModerations(request, env, rt);
    }

    if (url.pathname === "/v1/translations" || url.pathname === "/translations") {
      return handleTextTranslation(request, env, rt);
    }

    if (url.pathname.startsWith("/v1/chat/completions") || url.pathname.startsWith("/chat/completions")) {
      return handleChatCompletion(request, env, rt, spoofed);
    }

    return Response.json(
      { error: { message: `Unknown endpoint: ${url.pathname}`, type: "invalid_request_error" } },
      { status: 404 }
    );
  },
};

async function fetchStatusData(env) {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();

  const gql = `{
    viewer {
      accounts(filter:{accountTag:"${env.CF_ACCOUNT_ID}"}) {
        neurons: aiInferenceAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${todayStart.toISOString()}", datetime_leq: "${now.toISOString()}" }
          orderBy: [sum_totalNeurons_DESC]
        ) {
          count
          sum { totalNeurons totalInputTokens totalOutputTokens totalInferenceTimeMs }
          dimensions { modelId }
        }
        monthly: aiInferenceAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${monthStart.toISOString()}", datetime_leq: "${now.toISOString()}" }
        ) {
          sum { totalNeurons }
          count
        }
        invocations: workersInvocationsAdaptive(
          limit: 10
          filter: {
            datetime_geq: "${todayStart.toISOString()}"
            datetime_leq: "${now.toISOString()}"
            scriptName: "${env.WORKER_NAME || "cng"}"
          }
        ) {
          sum { requests errors subrequests }
          dimensions { status }
        }
      }
    }
  }`;

  const gqlResp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: gql }),
  });

  const gqlData = await gqlResp.json().catch(() => null);
  const acct = gqlData?.data?.viewer?.accounts?.[0] || {};

  const neuronRows = (acct.neurons || []).map((r) => ({
    model: r.dimensions.modelId.split("/").pop(),
    model_full: r.dimensions.modelId,
    requests: r.count,
    neurons: Math.round(r.sum.totalNeurons * 100) / 100,
    input_tokens: r.sum.totalInputTokens,
    output_tokens: r.sum.totalOutputTokens,
    inference_ms: r.sum.totalInferenceTimeMs,
  }));

  const totalNeurons = neuronRows.reduce((s, r) => s + r.neurons, 0);
  const totalRequests = neuronRows.reduce((s, r) => s + r.requests, 0);

  const monthlyAgg = (acct.monthly || [])[0] || { sum: { totalNeurons: 0 }, count: 0 };
  const monthlyTotalNeurons = monthlyAgg.sum.totalNeurons;
  const basePlan = 5.0;
  const avgDaily = dayOfMonth > 0 ? monthlyTotalNeurons / dayOfMonth : 0;
  const estDailyOverage = Math.max(0, avgDaily - 10000);
  const monthlyOverage = estDailyOverage * dayOfMonth;
  const monthlyOverageCost = (monthlyOverage / 1000) * 0.011;
  const projOverage = estDailyOverage * daysInMonth;
  const projCost = basePlan + (projOverage / 1000) * 0.011;

  const invocations = (acct.invocations || []).reduce(
    (acc, r) => {
      acc.requests += r.sum.requests;
      acc.errors += r.sum.errors;
      return acc;
    },
    { requests: 0, errors: 0 }
  );

  const rateState = {};
  for (const [id, bucket] of rateBuckets.entries()) {
    const cfg = API_KEYS[id];
    const elapsed = now.getTime() - (bucket?.start || 0);
    rateState[id] = {
      used: elapsed > 60_000 ? 0 : bucket.count,
      limit: cfg?.rpm || 0,
      window_remaining_s: Math.max(0, Math.round((60_000 - elapsed) / 1000)),
    };
  }

  return {
    timestamp: now.toISOString(),
    account_id: env.CF_ACCOUNT_ID,
    period: "today_utc",
    period_start: todayStart.toISOString(),
    neurons: {
      total: Math.round(totalNeurons * 100) / 100,
      included: 10000,
      overage: Math.max(0, Math.round((totalNeurons - 10000) * 100) / 100),
      overage_cost_usd: Math.max(0, ((totalNeurons - 10000) / 1000) * 0.011),
      by_model: neuronRows,
    },
    costs: {
      month: now.toISOString().slice(0, 7),
      base_plan_usd: basePlan,
      neurons_total: Math.round(monthlyTotalNeurons * 100) / 100,
      neurons_overage: Math.round(monthlyOverage * 100) / 100,
      neurons_cost_usd: Math.round(monthlyOverageCost * 10000) / 10000,
      month_to_date_usd: Math.round((basePlan + monthlyOverageCost) * 100) / 100,
      projected_month_usd: Math.round(projCost * 100) / 100,
      days_elapsed: dayOfMonth,
      days_in_month: daysInMonth,
    },
    ai_requests: { total: totalRequests },
    worker: {
      name: env.WORKER_NAME || "cng",
      invocations: invocations.requests,
      errors: invocations.errors,
    },
    rate_limits: rateState,
  };
}

function renderAsciiStatus(data) {
  const W = 48;
  const IW = W - 2;
  const hr = "─".repeat(W);

  function pad(s, w, align) {
    s = String(s);
    if (s.length >= w) return s.slice(0, w);
    const gap = w - s.length;
    if (align === "r") return " ".repeat(gap) + s;
    if (align === "c") {
      const l = Math.floor(gap / 2);
      return " ".repeat(l) + s + " ".repeat(gap - l);
    }
    return s + " ".repeat(gap);
  }
  function row(s) {
    return "│ " + (s + " ".repeat(IW)).slice(0, IW) + " │";
  }
  function rowC(s) {
    return "│" + pad(s, W, "c") + "│";
  }
  function fmt(v) {
    if (v >= 100000) return (v / 1000).toFixed(0) + "k";
    if (v >= 1000) return (v / 1000).toFixed(1) + "k";
    return v % 1 === 0 ? String(v) : v.toFixed(1);
  }

  const n = data.neurons;
  const pct = n.included > 0
    ? Math.min(100, (n.total / n.included) * 100)
    : 0;
  const over = n.overage > 0;

  let eyeL = "●", eyeR = "●", mouth = "◠";
  if (pct > 200) { eyeL = "×"; eyeR = "×"; mouth = "~"; }
  else if (pct > 100) { eyeL = "◎"; eyeR = "◎"; mouth = "△"; }
  else if (pct > 80) { eyeL = "●"; eyeR = "●"; mouth = "─"; }

  const barW = IW - 4;
  const barPct = Math.min(pct, 100);
  const filled = Math.round((barPct / 100) * barW);
  const bar = "█".repeat(filled) + "░".repeat(barW - filled);

  const ts = data.timestamp.slice(0, 16).replace("T", " ") + " UTC";

  const w = data.worker;
  const errPct = w.invocations > 0
    ? ((w.errors / w.invocations) * 100).toFixed(1) + "%"
    : "—";

  const lines = [];
  lines.push("╭" + hr + "╮");
  lines.push(rowC("Cloudflare Neuron Gate"));
  lines.push(row(""));
  lines.push(row("        ○"));
  lines.push(row("        │"));
  lines.push(row("      ╱───╲"));
  lines.push(row("    ╱  " + eyeL + " " + eyeR + "  ╲    CNG"));
  lines.push(row("    ╲   " + mouth + "   ╱    " + ts));
  lines.push(row("      ╲───╱"));
  lines.push("├" + hr + "┤");

  if (over) {
    const cost = "$" + n.overage_cost_usd.toFixed(2);
    lines.push(row(
      "Neurons  " + pad(fmt(n.total), 8, "r")
      + pad("OVER by " + fmt(n.overage), 16, "r")
      + pad(cost, 10, "r"),
    ));
    lines.push(row("  " + bar + ">>"));
    lines.push(row(""));
  } else {
    const left = fmt(n.included - n.total);
    lines.push(row(
      "Neurons " + pad(fmt(n.total), 7, "r") + " / " + fmt(n.included)
      + pad(left + " left", 13, "r")
      + pad("$0.00", 8, "r"),
    ));
    lines.push(row("  " + bar));
    lines.push(row(""));
  }

  lines.push("├" + hr + "┤");
  lines.push(row(
    pad("Model", 20) + pad("Reqs", 8, "r")
    + pad("Neurons", 10, "r") + pad("ms", 8, "r"),
  ));
  lines.push(row("─".repeat(IW)));

  for (const m of n.by_model) {
    lines.push(row(
      pad(m.model, 20)
      + pad(String(m.requests), 8, "r")
      + pad(fmt(m.neurons), 10, "r")
      + pad(fmt(m.inference_ms), 8, "r"),
    ));
  }
  if (!n.by_model.length) {
    lines.push(rowC("(no inference today)"));
  }

  lines.push("├" + hr + "┤");
  lines.push(row("Worker  " + w.name));
  lines.push(row(
    "Reqs " + pad(String(w.invocations), 6, "r")
    + "   Errors " + pad(String(w.errors), 4, "r")
    + " (" + errPct + ")",
  ));

  lines.push("├" + hr + "┤");
  lines.push(row(pad("Key", 10) + pad("RPM", 14, "r") + pad("Window", 14, "r")));
  for (const [key, rl] of Object.entries(data.rate_limits)) {
    lines.push(row(
      pad(key, 10)
      + pad(rl.used + " / " + rl.limit, 14, "r")
      + pad(rl.window_remaining_s + "s left", 14, "r"),
    ));
  }

  const c = data.costs;
  const mo = c.month.slice(5);
  const moNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const moLabel = moNames[parseInt(mo, 10)] + " " + c.month.slice(0, 4);

  lines.push("├" + hr + "┤");
  lines.push(row("Costs · " + moLabel + pad("day " + c.days_elapsed + "/" + c.days_in_month, IW - 10 - moLabel.length, "r")));
  lines.push(row("─".repeat(IW)));
  lines.push(row(
    pad("  Workers plan", 30) + pad("$" + c.base_plan_usd.toFixed(2), 16, "r"),
  ));
  lines.push(row(
    pad("  AI neurons " + fmt(c.neurons_overage) + " over", 30)
    + pad("$" + c.neurons_cost_usd.toFixed(2), 16, "r"),
  ));
  lines.push(row("─".repeat(IW)));
  lines.push(row(
    pad("  Month to date", 30) + pad("$" + c.month_to_date_usd.toFixed(2), 16, "r"),
  ));
  lines.push(row(
    pad("  Projected month-end", 30)
    + pad("~$" + c.projected_month_usd.toFixed(2), 16, "r"),
  ));
  lines.push("╰" + hr + "╯");

  return lines.join("\n");
}

async function handleServeImage(url) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (!cached) {
    return new Response("Not found", { status: 404 });
  }
  return cached;
}

async function handleImageGeneration(request, env, rt, spoofed) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 }
    );
  }
  const prompt = body.prompt || "";
  const requestedModel = body.model || "flux-1-schnell";
  const model = rt.imageMap[requestedModel] || rt.aliasMap[requestedModel] || Object.values(rt.imageMap)[0] || "@cf/black-forest-labs/flux-1-schnell";
  const defaultFmt = spoofed ? "url" : "b64_json";
  const wantUrl = (body.response_format || defaultFmt) === "url";
  const size = body.size || "1024x1024";
  const [w, h] = size.split("x").map(Number);
  const maxDim = rt.multipartSet.has(model) ? 1920 : 1024;
  const width = Math.min(w || 1024, maxDim);
  const height = Math.min(h || 1024, maxDim);

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const effectivePrompt =
      attempt === 0
        ? prompt
        : `Product photography, professional studio: ${prompt}`;

    const aiResponse = rt.multipartSet.has(model)
      ? await callImageMultipart(env, model, effectivePrompt, width, height)
      : await callImageJson(env, model, effectivePrompt, width, height);

    const result = await aiResponse.json().catch(() => null);

    const isNsfw =
      !aiResponse.ok && JSON.stringify(result || "").toLowerCase().includes("nsfw");

    if (isNsfw && attempt < MAX_RETRIES) {
      continue;
    }

    if (!aiResponse.ok || !result?.result?.image) {
      const msg = result?.errors?.[0]?.message || "Image generation failed";
      return Response.json(
        { error: { message: msg, type: "server_error" } },
        { status: aiResponse.status }
      );
    }

    const backendModel = model.split("/").pop();
    const revisedPrompt = `[${backendModel}] ${effectivePrompt}`;
    const b64 = result.result.image;

    if (wantUrl) {
      const imgId = crypto.randomUUID();
      const imgUrl = new URL(`/img/${imgId}`, request.url).toString();
      const imgBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const imgResp = new Response(imgBytes, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600",
        },
      });
      await caches.default.put(new Request(imgUrl), imgResp);

      return Response.json({
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        data: [{ url: imgUrl, revised_prompt: revisedPrompt }],
      });
    }

    return Response.json({
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      data: [{ b64_json: b64, revised_prompt: revisedPrompt }],
    });
  }
}

async function callImageJson(env, model, prompt, width, height) {
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt, width, height, num_steps: 4 }),
    }
  );
}

async function callImageMultipart(env, model, prompt, width, height) {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(width));
  form.append("height", String(height));

  const formResp = new Response(form);
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": formResp.headers.get("content-type"),
      },
      body: formResp.body,
    }
  );
}

function handleListModels(cfg, spoofed) {
  const data = [];

  if (spoofed) {
    for (const a of cfg.aliases || []) {
      data.push({ id: a.name, object: "model", owned_by: "openai" });
    }
  } else {
    const ownerFromPath = (p) => { const parts = p.split("/"); return parts.length >= 3 ? parts[2] : "system"; };
    for (const m of cfg.chatModels || []) {
      data.push({ id: m.id, object: "model", owned_by: ownerFromPath(m.path) });
    }
    for (const m of cfg.imageModels || []) {
      data.push({ id: m.id, object: "model", owned_by: ownerFromPath(m.path) });
    }
    for (const m of cfg.voiceModels || []) {
      data.push({ id: m.id, object: "model", owned_by: ownerFromPath(m.path) });
    }
    for (const m of cfg.utilityModels || []) {
      data.push({ id: m.id, object: "model", owned_by: ownerFromPath(m.path) });
    }
  }

  return Response.json({ object: "list", data });
}

function stripThinking(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/gi, "")
    .trimStart();
}

function errorString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((e) => e.message || String(e)).join("; ");
  return String(value);
}

function prepareMessages(body, rt) {
  const requestedModel = body.model || "";
  const model = rt.chatMap[requestedModel] || rt.aliasMap[requestedModel]
    || rt.chatMap[requestedModel.split("/").pop()];

  if (!model) {
    return { error: `Model not allowed: ${body.model}` };
  }

  const isAlias = !!rt.aliasMap[requestedModel];
  const isVision = rt.visionSet.has(model);
  const MAX_CONTEXT = rt.contextMap[model] || 32768;
  const maxTokens = Math.min(body.max_tokens || 2048, Math.min(MAX_CONTEXT / 4, 16384));
  const inputBudget = MAX_CONTEXT - maxTokens;

  const normalized = (body.messages || []).map((msg) => {
    if (!Array.isArray(msg.content)) {
      return { role: msg.role, content: String(msg.content ?? "") };
    }
    if (isVision) {
      return { role: msg.role, content: msg.content };
    }
    return {
      role: msg.role,
      content: msg.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n"),
    };
  });

  const contentLen = (c) => typeof c === "string" ? c.length : JSON.stringify(c).length;
  const estimateTokens = (c) => Math.ceil(contentLen(c) / 3.5);

  const system = normalized.filter((m) => m.role === "system");
  const rest = normalized.filter((m) => m.role !== "system");

  if (isAlias && model.includes("qwen")) {
    const noThinkMsg = { role: "system", content: "/no_think" };
    system.push(noThinkMsg);
  }

  let used = system.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const messages = [...system];

  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokens(rest[i].content);
    if (used + cost > inputBudget) break;
    messages.splice(system.length, 0, rest[i]);
    used += cost;
  }

  return { model, messages, maxTokens, requestedModel };
}

async function handleChatCompletion(request, env, rt, spoofed) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 }
    );
  }
  const prepared = prepareMessages(body, rt);

  if (prepared.error) {
    return Response.json(
      { error: { message: prepared.error, type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  const { model, messages, maxTokens, requestedModel } = prepared;
  const wantStream = Boolean(body.stream);

  const aiResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages,
        max_tokens: maxTokens,
        temperature: body.temperature ?? 0.6,
        stream: wantStream,
        ...(body.top_p != null && { top_p: body.top_p }),
        ...(body.frequency_penalty != null && { frequency_penalty: body.frequency_penalty }),
        ...(body.presence_penalty != null && { presence_penalty: body.presence_penalty }),
        ...(body.repetition_penalty != null && { repetition_penalty: body.repetition_penalty }),
        ...(body.seed != null && { seed: body.seed }),
        ...(body.tools && { tools: body.tools }),
        ...(body.tool_choice && { tool_choice: body.tool_choice }),
      }),
    }
  );

  if (wantStream) {
    return handleStreamingResponse(aiResponse, requestedModel);
  }

  return handleNonStreamingResponse(aiResponse, requestedModel);
}

async function handleStreamingResponse(aiResponse, requestedModel) {
  if (!aiResponse.ok || !aiResponse.body) {
    const text = await aiResponse.text().catch(() => "");
    let msg = "Workers AI request failed";
    try { msg = errorString(JSON.parse(text).errors) || msg; } catch {}
    return Response.json(
      { error: { message: msg, type: "api_error" } },
      { status: aiResponse.status || 502 }
    );
  }

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const writeChunk = async (data) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  (async () => {
    try {
      const reader = aiResponse.body.getReader();
      let buffer = "";
      let sentRole = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;

          let parsed;
          try { parsed = JSON.parse(payload); } catch { continue; }

          const r = parsed.result ?? parsed;
          const choice = r.choices?.[0];

          if (r.response != null) {
            const delta = sentRole
              ? { content: r.response }
              : { role: "assistant", content: r.response };
            sentRole = true;
            await writeChunk({
              id, object: "chat.completion.chunk", created, model: requestedModel,
              choices: [{ index: 0, delta, finish_reason: null }],
            });
            continue;
          }

          if (choice?.delta) {
            const delta = {};
            if (!sentRole) delta.role = "assistant";
            if (choice.delta.content != null) delta.content = choice.delta.content;
            if (choice.delta.tool_calls) delta.tool_calls = choice.delta.tool_calls;

            if (!sentRole || delta.content || delta.tool_calls) {
              sentRole = true;
              await writeChunk({
                id, object: "chat.completion.chunk", created, model: requestedModel,
                choices: [{ index: 0, delta, finish_reason: null }],
              });
            }

            if (choice.finish_reason) {
              await writeChunk({
                id, object: "chat.completion.chunk", created, model: requestedModel,
                choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
                ...(r.usage && { usage: r.usage }),
              });
            }
          }
        }
      }
    } catch {
      await writer.write(
        encoder.encode(`data: ${JSON.stringify({ error: { message: "Stream interrupted", type: "stream_error" } })}\n\n`)
      ).catch(() => {});
    } finally {
      await writer.write(encoder.encode("data: [DONE]\n\n")).catch(() => {});
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function handleEmbeddings(request, env, rt) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 }
    );
  }
  const reqModel = body.model || "bge-m3";
  const model = rt.embeddingMap[reqModel];

  if (!model) {
    return Response.json(
      { error: { message: `Embedding model not allowed: ${reqModel}`, type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  const input = Array.isArray(body.input) ? body.input : [body.input || ""];

  const aiResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: input }),
    }
  );

  const result = await aiResponse.json().catch(() => null);

  if (!aiResponse.ok || !result?.result) {
    const msg = result?.errors?.[0]?.message || "Embedding request failed";
    return Response.json(
      { error: { message: msg, type: "api_error" } },
      { status: aiResponse.status }
    );
  }

  const vectors = result.result.data || result.result.response || result.result;
  const data = (Array.isArray(vectors) ? vectors : [vectors]).map((emb, i) => ({
    object: "embedding",
    index: i,
    embedding: Array.isArray(emb) ? emb : emb.values || emb,
  }));

  const totalTokens = input.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);

  return Response.json({
    object: "list",
    data,
    model: model.split("/").pop(),
    usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
  });
}

async function handleNonStreamingResponse(aiResponse, requestedModel) {
  const text = await aiResponse.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return Response.json(
      { error: { message: "Upstream returned invalid response", type: "api_error" } },
      { status: 502 }
    );
  }

  if (!aiResponse.ok) {
    const msg = errorString(result.errors) || "Workers AI request failed";
    return Response.json(
      { error: { message: msg, type: "api_error" } },
      { status: aiResponse.status }
    );
  }

  const r = result.result;
  const msg = r.choices?.[0]?.message;
  const rawContent = r.response
    || (msg?.content != null ? msg.content : null)
    || "";
  const content = stripThinking(rawContent);

  const usage = r.usage || r.choices?.[0]?.usage || {};

  return Response.json({
    id: r.id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(msg?.tool_calls && { tool_calls: msg.tool_calls }),
        },
        finish_reason: r.choices?.[0]?.finish_reason || "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
  });
}

async function handleAudioTranscription(request, env, rt) {
  const ct = request.headers.get("content-type") || "";
  let audioData, requestedModel = "whisper-large-v3-turbo", responseFormat = "json";

  if (ct.includes("multipart")) {
    const form = await request.formData().catch(() => null);
    if (!form) return Response.json({ error: { message: "Invalid form data", type: "invalid_request_error" } }, { status: 400 });
    const file = form.get("file");
    if (!file) return Response.json({ error: { message: "Missing 'file' field", type: "invalid_request_error" } }, { status: 400 });
    audioData = await file.arrayBuffer();
    requestedModel = form.get("model") || requestedModel;
    responseFormat = form.get("response_format") || responseFormat;
  } else {
    audioData = await request.arrayBuffer();
  }

  const model = rt.sttMap[requestedModel] || rt.aliasMap[requestedModel] || Object.values(rt.sttMap)[0] || "@cf/openai/whisper-large-v3-turbo";
  const aiResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`,
    { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: audioData }
  );

  const result = await aiResp.json().catch(() => null);
  if (!aiResp.ok || !result?.result) {
    return Response.json(
      { error: { message: result?.errors?.[0]?.message || "Transcription failed", type: "server_error" } },
      { status: aiResp.status }
    );
  }

  const text = result.result.text || "";
  if (responseFormat === "text") return new Response(text, { headers: { "Content-Type": "text/plain" } });
  if (responseFormat === "vtt") return new Response(result.result.vtt || text, { headers: { "Content-Type": "text/vtt" } });
  if (responseFormat === "verbose_json") {
    return Response.json({
      task: "transcribe", language: result.result.language || "en",
      duration: result.result.duration || 0, text,
      words: result.result.words || [], segments: result.result.segments || [],
    });
  }
  return Response.json({ text });
}

async function handleAudioTranslation(request, env, rt) {
  const ct = request.headers.get("content-type") || "";
  let audioData, responseFormat = "json";

  if (ct.includes("multipart")) {
    const form = await request.formData().catch(() => null);
    if (!form) return Response.json({ error: { message: "Invalid form data", type: "invalid_request_error" } }, { status: 400 });
    const file = form.get("file");
    if (!file) return Response.json({ error: { message: "Missing 'file' field", type: "invalid_request_error" } }, { status: 400 });
    audioData = await file.arrayBuffer();
    responseFormat = form.get("response_format") || responseFormat;
  } else {
    audioData = await request.arrayBuffer();
  }

  const sttModel = Object.values(rt.sttMap)[0] || "@cf/openai/whisper-large-v3-turbo";
  const aiResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${sttModel}`,
    { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: audioData }
  );

  const result = await aiResp.json().catch(() => null);
  if (!aiResp.ok || !result?.result) {
    return Response.json(
      { error: { message: result?.errors?.[0]?.message || "Translation failed", type: "server_error" } },
      { status: aiResp.status }
    );
  }

  const text = result.result.text || "";
  if (responseFormat === "text") return new Response(text, { headers: { "Content-Type": "text/plain" } });
  if (responseFormat === "verbose_json") {
    return Response.json({
      task: "translate", language: result.result.language || "en",
      duration: result.result.duration || 0, text,
    });
  }
  return Response.json({ text });
}

async function handleAudioSpeech(request, env, rt) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  }

  const input = body.input || "";
  if (!input) return Response.json({ error: { message: "Missing 'input' field", type: "invalid_request_error" } }, { status: 400 });

  const reqModel = body.model || "tts-1";
  const model = rt.ttsMap[reqModel] || rt.aliasMap[reqModel] || Object.values(rt.ttsMap)[0] || "@cf/deepgram/aura-2-en";
  const audioFmt = body.response_format || "mp3";
  const payload = model.includes("melotts") ? { text: input, lang: "EN" } : { text: input };

  const aiResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  if (!aiResp.ok) {
    const err = await aiResp.text().catch(() => "");
    let msg = "TTS failed";
    try { msg = JSON.parse(err).errors?.[0]?.message || msg; } catch {}
    return Response.json({ error: { message: msg, type: "server_error" } }, { status: aiResp.status });
  }

  const ctMap = { mp3: "audio/mpeg", opus: "audio/opus", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav", pcm: "audio/pcm" };
  return new Response(aiResp.body, {
    headers: { "Content-Type": ctMap[audioFmt] || "audio/mpeg", "Transfer-Encoding": "chunked" },
  });
}

async function handleImageEdits(request, env, rt, spoofed) {
  if (!rt.inpaintingModel) {
    return Response.json({ error: { message: "No inpainting model configured. Enable an image model with inpainting flag.", type: "invalid_request_error" } }, { status: 400 });
  }
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: { message: "Expected multipart form data", type: "invalid_request_error" } }, { status: 400 });

  const image = form.get("image");
  const mask = form.get("mask");
  const prompt = form.get("prompt") || "";
  if (!image || !prompt) return Response.json({ error: { message: "Missing required: image, prompt", type: "invalid_request_error" } }, { status: 400 });

  const wantUrl = (form.get("response_format") || (spoofed ? "url" : "b64_json")) === "url";
  const fwd = new FormData();
  fwd.append("image", image);
  if (mask) fwd.append("mask", mask);
  fwd.append("prompt", prompt);
  const fwdResp = new Response(fwd);

  const aiResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${rt.inpaintingModel}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": fwdResp.headers.get("content-type") },
      body: fwdResp.body,
    }
  );

  const result = await aiResp.json().catch(() => null);
  if (!aiResp.ok || !result?.result?.image) {
    return Response.json(
      { error: { message: result?.errors?.[0]?.message || "Image edit failed", type: "server_error" } },
      { status: aiResp.status }
    );
  }

  const b64 = result.result.image;
  if (wantUrl) {
    const imgId = crypto.randomUUID();
    const imgUrl = new URL("/img/" + imgId, request.url).toString();
    await caches.default.put(new Request(imgUrl), new Response(
      Uint8Array.from(atob(b64), c => c.charCodeAt(0)),
      { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } }
    ));
    return Response.json({ created: Math.floor(Date.now() / 1000), data: [{ url: imgUrl, revised_prompt: prompt }] });
  }
  return Response.json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64, revised_prompt: prompt }] });
}

async function handleModerations(request, env, rt) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  }

  if (!rt.moderationModel) {
    return Response.json({ error: { message: "No moderation model configured. Enable a utility model with moderation kind.", type: "invalid_request_error" } }, { status: 400 });
  }
  const modModel = rt.moderationModel;
  const inputs = Array.isArray(body.input) ? body.input : [body.input || ""];
  const results = [];

  for (const text of inputs) {
    const aiResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${modModel}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
      }
    );

    const res = await aiResp.json().catch(() => null);
    const output = (res?.result?.response || "safe").trim().toLowerCase();
    const flagged = output.includes("unsafe");
    const cats = {};
    const scores = {};
    const allCats = ["sexual","hate","harassment","self-harm","sexual/minors",
      "hate/threatening","violence/graphic","violence","harassment/threatening",
      "self-harm/intent","self-harm/instructions"];
    for (const c of allCats) { cats[c] = false; scores[c] = 0; }

    if (flagged) {
      const codeMap = { S1:"violence", S2:"harassment", S3:"sexual", S4:"sexual/minors",
        S5:"harassment", S9:"violence/graphic", S10:"hate", S11:"self-harm", S12:"sexual" };
      for (const line of output.split("\n")) {
        const cat = codeMap[line.trim().toUpperCase()];
        if (cat) { cats[cat] = true; scores[cat] = 0.95; }
      }
    }
    results.push({ flagged, categories: cats, category_scores: scores });
  }

  return Response.json({ id: "modr-" + crypto.randomUUID(), model: modModel.split("/").pop(), results });
}

async function handleTextTranslation(request, env, rt) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  }

  const text = body.text || body.input || "";
  if (!text) return Response.json({ error: { message: "Missing 'text' field", type: "invalid_request_error" } }, { status: 400 });

  const sourceLang = body.source_lang || body.source || "en";
  const targetLang = body.target_lang || body.target || "es";
  const reqModel = body.model || "m2m100-1.2b";
  const model = rt.translationMap[reqModel] || Object.values(rt.translationMap)[0];

  if (!model) {
    return Response.json({ error: { message: `Translation model not available: ${reqModel}`, type: "invalid_request_error" } }, { status: 400 });
  }

  const aiResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, source_lang: sourceLang, target_lang: targetLang }),
    }
  );

  const result = await aiResp.json().catch(() => null);
  if (!aiResp.ok || !result?.result) {
    return Response.json(
      { error: { message: result?.errors?.[0]?.message || "Translation failed", type: "server_error" } },
      { status: aiResp.status }
    );
  }

  return Response.json({
    translated_text: result.result.translated_text || "",
    source_lang: sourceLang,
    target_lang: targetLang,
    model: reqModel,
  });
}

const TASK_MAP = {
  "Text Generation": "chatModels",
  "Text-to-Image": "imageModels",
  "Automatic Speech Recognition": "voiceModels",
  "Text-to-Speech": "voiceModels",
  "Text Embeddings": "utilityModels",
  "Translation": "utilityModels",
  "Text Classification": "utilityModels",
  "Image-to-Text": "chatModels",
  "Summarization": "utilityModels",
  "Object Detection": "utilityModels",
  "Image Classification": "utilityModels",
};

const TASK_KIND = {
  "Automatic Speech Recognition": "stt",
  "Text-to-Speech": "tts",
  "Text Embeddings": "embedding",
  "Translation": "translation",
  "Text Classification": "moderation",
  "Summarization": "summarization",
  "Object Detection": "detection",
  "Image Classification": "classification",
};

async function handleDiscover(env, cfg) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/models/search?per_page=200`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.result) {
    return Response.json({ error: "Failed to fetch models from Cloudflare API" }, { status: 502 });
  }

  const existingPaths = new Set();
  for (const list of [cfg.chatModels, cfg.imageModels, cfg.voiceModels, cfg.utilityModels]) {
    for (const m of list || []) existingPaths.add(m.path);
  }

  const models = [];
  for (const m of data.result) {
    const taskName = m.task?.name || "";
    const category = TASK_MAP[taskName];
    if (!category) continue;

    const props = {};
    for (const p of m.properties || []) props[p.property_id] = p.value;

    const entry = {
      name: m.name,
      id: m.name.split("/").pop(),
      description: m.description || "",
      task: taskName,
      category,
      existing: existingPaths.has(m.name),
      beta: props.beta === "true",
      deprecated: props.planned_deprecation_date || null,
      contextWindow: props.context_window ? parseInt(props.context_window, 10) : null,
      functionCalling: props.function_calling === "true",
      reasoning: props.reasoning === "true",
      pricing: null,
    };

    if (Array.isArray(props.price)) {
      entry.pricing = {};
      for (const p of props.price) {
        if (p.unit?.includes("input")) entry.pricing.input = p.price;
        else if (p.unit?.includes("output")) entry.pricing.output = p.price;
        else entry.pricing.unit = p.price + " / " + (p.unit || "unit");
      }
      if (!Object.keys(entry.pricing).length) entry.pricing = null;
    }

    if (category === "voiceModels") {
      entry.kind = TASK_KIND[taskName] || "stt";
    } else if (category === "utilityModels") {
      entry.kind = TASK_KIND[taskName] || "other";
    }

    if (taskName === "Text Generation") {
      entry.vision = props.vision === "true" || !!(m.tags || []).find(t => t === "vision");
    }

    if (taskName === "Image-to-Text") {
      entry.vision = true;
    }

    if (taskName === "Text-to-Image") {
      entry.inpainting = m.name.includes("inpainting");
    }

    models.push(entry);
  }

  models.sort((a, b) => {
    if (a.existing !== b.existing) return a.existing ? 1 : -1;
    if (a.beta !== b.beta) return a.beta ? 1 : -1;
    if (a.deprecated && !b.deprecated) return 1;
    return a.id.localeCompare(b.id);
  });

  return Response.json({
    models,
    total: data.result.length,
    discovered: models.length,
    new: models.filter(m => !m.existing).length,
    dashboard: `https://dash.cloudflare.com/${env.CF_ACCOUNT_ID}/ai/workers-ai`,
  });
}

async function handleGetUsers(env) {
  const config = await loadConfig(env);
  const spoofed = config.spoofedKeys || [];
  const names = config.keyNames || {};
  const envUsers = Object.entries(API_KEYS).map(([id, cfg]) => ({
    id, name: names[id] || id, rpm: cfg.rpm, source: "env", spoofed: spoofed.includes(id),
  }));
  const kvUsers = (config.users || []).map(u => ({
    id: u.id, name: names[u.id] || u.id, rpm: u.rpm, keyPreview: u.keyPreview || "****",
    created: u.created || "", source: "kv", spoofed: spoofed.includes(u.id),
  }));
  const rateState = {};
  const now = Date.now();
  for (const [id, bucket] of rateBuckets.entries()) {
    const cfg = API_KEYS[id];
    const elapsed = now - (bucket?.start || 0);
    rateState[id] = { used: elapsed > 60000 ? 0 : bucket.count, limit: cfg?.rpm || 0 };
  }
  return Response.json({ env_users: envUsers, kv_users: kvUsers, kv_available: !!env.CONFIG, rate_limits: rateState });
}

async function handleUserAction(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const config = await loadConfig(env);
  if (!config.users) config.users = [];

  async function persist() {
    _cfgCache = config; _cfgCacheTime = Date.now();
    if (env.CONFIG) await env.CONFIG.put("gateway-config", JSON.stringify(config));
    return env.CONFIG ? "kv" : "memory";
  }

  if (body.action === "create") {
    if (!body.id) return Response.json({ error: "Missing user ID" }, { status: 400 });
    if (API_KEYS[body.id] || config.users.some(u => u.id === body.id))
      return Response.json({ error: "User already exists" }, { status: 400 });
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    const key = btoa(String.fromCharCode(...keyBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const keyHash = await hashKey(key);
    config.users.push({
      id: body.id, keyHash, keyPreview: "..." + key.slice(-4),
      rpm: body.rpm || 30, created: new Date().toISOString().slice(0, 10),
    });
    const storage = await persist();
    return Response.json({ ok: true, id: body.id, key, storage });
  }

  if (body.action === "delete") {
    config.users = config.users.filter(u => u.id !== body.id);
    const storage = await persist();
    return Response.json({ ok: true, storage });
  }

  if (body.action === "update") {
    const user = config.users.find(u => u.id === body.id);
    if (!user) return Response.json({ error: "User not found" }, { status: 404 });
    if (body.rpm != null) user.rpm = body.rpm;
    const storage = await persist();
    return Response.json({ ok: true, storage });
  }

  if (body.action === "toggle_spoof") {
    if (!config.spoofedKeys) config.spoofedKeys = [];
    const idx = config.spoofedKeys.indexOf(body.id);
    if (idx >= 0) config.spoofedKeys.splice(idx, 1);
    else config.spoofedKeys.push(body.id);
    const storage = await persist();
    return Response.json({ ok: true, spoofed: config.spoofedKeys.includes(body.id), storage });
  }

  if (body.action === "rename_key") {
    if (!body.id || typeof body.name !== "string") return Response.json({ error: "Missing id or name" }, { status: 400 });
    if (!config.keyNames) config.keyNames = {};
    const trimmed = body.name.trim().slice(0, 128);
    if (trimmed && trimmed !== body.id) config.keyNames[body.id] = trimmed;
    else delete config.keyNames[body.id];
    const storage = await persist();
    return Response.json({ ok: true, name: trimmed || body.id, storage });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

const DEFAULT_CONFIG = {
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

async function loadConfig(env, skipCache) {
  const now = Date.now();
  if (!skipCache && _cfgCache && now - _cfgCacheTime < 30000) return _cfgCache;
  if (!env.CONFIG) return DEFAULT_CONFIG;
  const raw = await env.CONFIG.get("gateway-config", "json").catch(() => null);
  _cfgCache = raw ? { ...DEFAULT_CONFIG, ...raw } : DEFAULT_CONFIG;
  _cfgCacheTime = now;
  return _cfgCache;
}

async function handleGetConfig(env) {
  const cfg = await loadConfig(env);
  const safe = { ...cfg, _meta: { kv: !!env.CONFIG } };
  if (safe.users) {
    safe.users = safe.users.map(u => ({ id: u.id, rpm: u.rpm, keyPreview: u.keyPreview, created: u.created }));
  }
  return Response.json(safe);
}

async function handleSaveConfig(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const prev = await loadConfig(env, true);
  body.users = prev.users || [];
  body.spoofedKeys = prev.spoofedKeys || [];
  body.keyNames = prev.keyNames || {};
  _cfgCache = body;
  _cfgCacheTime = Date.now();
  if (env.CONFIG) {
    await env.CONFIG.put("gateway-config", JSON.stringify(body));
    return Response.json({ ok: true, storage: "kv" });
  }
  return Response.json({ ok: true, storage: "memory" });
}

const CONFIG_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CNG · Cloudflare Neuron Gate</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%2358a6ff'/%3E%3Cstop offset='100%25' stop-color='%23a371f7'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpolygon points='100,35 155,67.5 155,132.5 100,165 45,132.5 45,67.5' fill='%230d1117' stroke='url(%23g)' stroke-width='6'/%3E%3Ccircle cx='78' cy='90' r='10' fill='%23238636'/%3E%3Ccircle cx='122' cy='90' r='10' fill='%23238636'/%3E%3Cpath d='M78 120Q100 138 122 120' fill='none' stroke='%23238636' stroke-width='5' stroke-linecap='round'/%3E%3Cline x1='100' y1='35' x2='100' y2='15' stroke='url(%23g)' stroke-width='4'/%3E%3Ccircle cx='100' cy='12' r='6' fill='%2358a6ff'/%3E%3C/svg%3E">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;padding:20px;max-width:1600px;margin:0 auto}
h1{color:#58a6ff;font-size:1.4em;margin-bottom:4px}
.sub{color:#8b949e;font-size:.85em;margin-bottom:20px}
.columns{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;align-items:stretch}
@media(max-width:1200px){.columns{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.columns{grid-template-columns:1fr}}
.section-title{color:#f0f6fc;font-size:1.15em;font-weight:700;margin:24px 0 12px;padding-bottom:6px;border-bottom:2px solid #21262d}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
@media(max-width:900px){.two-col{grid-template-columns:1fr}}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:900;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal-box{background:#0d1117;border:1px solid #30363d;border-radius:12px;width:90vw;max-width:800px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.6)}
.modal-header{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid #21262d}
.modal-header .modal-title{flex:1;color:#f0f6fc;font-weight:700;font-size:1.05em}
.modal-body{overflow-y:auto;padding:16px 20px}
.modal-footer{padding:10px 20px;border-top:1px solid #21262d;font-size:.8em;color:#8b949e}
.modal-footer a{color:#58a6ff;text-decoration:none}
.d-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px}
.d-card{display:flex;flex-direction:column;gap:4px;padding:8px 10px;background:#161b22;border:1px solid #30363d;border-radius:6px}
.d-card:hover{border-color:#58a6ff;background:#1c2129}
.d-card .d-name{color:#f0f6fc;font-weight:600;font-size:.8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.d-card .d-badges{display:flex;gap:3px;flex-wrap:wrap}
.d-card .d-act{margin-top:auto;display:flex;gap:4px;justify-content:flex-end;padding-top:3px}
.d-info-btn{background:none;border:1px solid #30363d;color:#8b949e;cursor:pointer;padding:2px 7px;border-radius:4px;font-size:.7em;line-height:1.2}
.d-info-btn:hover{color:#f0f6fc;border-color:#58a6ff}
.d-tooltip{display:none;position:fixed;background:#1c2129;border:1px solid #58a6ff;border-radius:6px;padding:10px 12px;color:#c9d1d9;font-size:.8em;max-width:360px;z-index:999;line-height:1.4;box-shadow:0 4px 12px rgba(0,0,0,.5)}
.d-tooltip .dt-title{color:#f0f6fc;font-weight:600;margin-bottom:4px}
.d-tooltip .dt-path{color:#8b949e;font-size:.85em;font-family:monospace;margin-bottom:6px}
.d-badge{font-size:.65em;padding:1px 6px;border-radius:3px;color:#c9d1d9;line-height:1.3}
.d-badge.beta{background:#d29922;color:#0d1117}
.d-badge.dep{background:#da3633;color:#fff}
.d-badge.vision{background:#238636;color:#fff}
.d-badge.fn{background:#1f6feb;color:#fff}
.d-badge.reason{background:#a371f7;color:#fff}
.d-badge.inpaint{background:#1a7f37;color:#fff}
.d-badge.price{background:#21262d;color:#8b949e}
.d-badge.ctx{background:#21262d;color:#58a6ff}
.d-badge.kind{background:#21262d;color:#d2a8ff}
.d-badge.existing{background:#30363d;color:#8b949e}
.d-add{background:#238636;color:#fff;border:none;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:.75em;white-space:nowrap}
.d-add:hover{background:#2ea043}
.d-add:disabled{background:#21262d;color:#8b949e;cursor:default}
.col{min-width:0;overflow:hidden;display:flex;flex-direction:column}
.col-scroll{flex:1;overflow-y:auto;max-height:55vh;min-height:80px;scrollbar-width:thin;scrollbar-color:#30363d transparent}
.col-scroll::-webkit-scrollbar{width:5px}
.col-scroll::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
h2{color:#f0f6fc;font-size:1.1em;margin:0 0 12px;border-bottom:1px solid #21262d;padding-bottom:6px}
.card{display:flex;align-items:center;gap:12px;padding:10px 12px;background:#161b22;border:1px solid #21262d;border-radius:8px;margin-bottom:8px}
.card .info{flex:1;min-width:0}
.card .name{font-weight:600;color:#f0f6fc;font-size:.95em}
.card .path{color:#8b949e;font-size:.75em;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}
.toggle{position:relative;width:42px;height:24px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.toggle .slider{position:absolute;cursor:pointer;inset:0;background:#21262d;border-radius:12px;transition:.2s}
.toggle input:checked+.slider{background:#238636}
.toggle .slider:before{content:"";position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#c9d1d9;border-radius:50%;transition:.2s}
.toggle input:checked+.slider:before{transform:translateX(18px)}
.arrows{display:flex;flex-direction:column;gap:2px}
.arrows button{background:none;border:1px solid #30363d;color:#8b949e;cursor:pointer;padding:1px 6px;border-radius:4px;font-size:.7em;line-height:1.2}
.arrows button:hover{color:#f0f6fc;border-color:#58a6ff}
.alias-row{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#161b22;border:1px solid #21262d;border-radius:8px;margin-bottom:8px}
.alias-row .spoof{font-weight:600;color:#f0f6fc;font-size:.9em;min-width:110px}
.alias-row .arrow-icon{color:#8b949e;font-size:.8em}
.alias-row select{flex:1;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:5px 8px;font-size:.85em}
.alias-row select:focus{border-color:#58a6ff;outline:none}
.alias-row .type-badge{font-size:.7em;padding:2px 6px;border-radius:4px;color:#8b949e;border:1px solid #30363d}
.spoof-lbl{color:#8b949e;font-size:.75em;cursor:help;white-space:nowrap;border-bottom:1px dotted #8b949e}
.inline-name:hover{border-bottom-color:#30363d !important}
.info-i{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid #8b949e;color:#8b949e;font-size:.6em;font-weight:700;cursor:help;margin-left:4px;vertical-align:middle;font-style:normal}
.del{background:none;border:1px solid #30363d;color:#8b949e;cursor:pointer;padding:2px 7px;border-radius:4px;font-size:.7em;line-height:1.2}
.del:hover{color:#da3633;border-color:#da3633}
.add-row{display:flex;gap:8px;margin-top:8px;align-items:center}
.add-row input,.add-row select{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:5px 8px;font-size:.85em}
.add-row input:focus,.add-row select:focus{border-color:#58a6ff;outline:none}
.add-row input{flex:1}
.add-btn{background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:.85em}
.add-btn:hover{border-color:#58a6ff;color:#f0f6fc}
.btn{background:#238636;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:.95em;margin-top:20px}
.btn:hover{background:#2ea043}
.btn:disabled{opacity:.5;cursor:not-allowed}
.toast{position:fixed;top:20px;right:20px;background:#238636;color:#fff;padding:10px 20px;border-radius:6px;display:none;font-size:.9em;z-index:99}
.toast.err{background:#da3633}
.cost-block h2{color:#f0f6fc;font-size:1.1em;margin:0;border:none;padding:0}
.cost-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:700px){.cost-grid{grid-template-columns:1fr}}
.cost-card{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:12px}
.cct{font-size:.85em;color:#8b949e;margin-bottom:8px}
.nbar{height:8px;background:#21262d;border-radius:4px;overflow:hidden;margin:6px 0}
.nfill{height:100%;background:#238636;border-radius:4px;transition:width .3s}
.nfill.warn{background:#d29922}
.nfill.over{background:#da3633}
.cr{display:flex;justify-content:space-between;padding:3px 0;font-size:.85em}
.cr.sep{border-top:1px solid #30363d;margin-top:4px;padding-top:6px;font-weight:600}
.mr{display:flex;gap:8px;padding:2px 0;font-size:.8em;color:#8b949e}
.mr span:first-child{flex:1;color:#c9d1d9;font-family:monospace}
.sts{font-size:.75em;color:#8b949e}
.rbtn{background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:.8em}
.rbtn:hover{border-color:#58a6ff;color:#f0f6fc}
.header-row{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.btn-del{background:none;border:1px solid #30363d;color:#8b949e;cursor:pointer;padding:3px 8px;border-radius:4px;font-size:.8em;margin-left:8px}
.btn-del:hover{color:#da3633;border-color:#da3633}
.save-status{font-size:.8em;color:#8b949e;transition:opacity .3s}
.save-status.saving{color:#d29922}
.save-status.saved{color:#238636}
.save-status.error{color:#da3633}
.footer{margin-top:40px;padding:16px 0;border-top:1px solid #21262d;text-align:center;color:#8b949e;font-size:.8em}
.footer a{color:#58a6ff;text-decoration:none}.footer a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="header-row">
<svg viewBox="0 0 200 200" width="50" height="50" style="flex-shrink:0;margin-top:-10px">
<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#58a6ff"/><stop offset="100%" stop-color="#a371f7"/></linearGradient></defs>
<polygon points="100,10 178,55 178,145 100,190 22,145 22,55" fill="none" stroke="url(#g)" stroke-width="6" opacity="0.6"/>
<polygon points="100,35 155,67.5 155,132.5 100,165 45,132.5 45,67.5" fill="#0d1117" stroke="url(#g)" stroke-width="4"/>
<circle cx="78" cy="90" r="10" fill="#238636"/><circle cx="122" cy="90" r="10" fill="#238636"/>
<path d="M 78 120 Q 100 138 122 120" fill="none" stroke="#238636" stroke-width="5" stroke-linecap="round"/>
<line x1="100" y1="35" x2="100" y2="15" stroke="url(#g)" stroke-width="4"/><circle cx="100" cy="12" r="6" fill="#58a6ff"/>
</svg>
<div><h1>CNG · Cloudflare Neuron Gate</h1>
<p class="sub">Models · Keys · Aliases · Live costs</p></div>
</div>
<div id="toast" class="toast"></div>
<div id="d-tip" class="d-tooltip"></div>
<div id="modal" class="modal-overlay" onclick="if(event.target===this)closeModal()">
<div class="modal-box">
<div class="modal-header">
<span class="modal-title" id="modal-title"></span>
<input id="modal-search" type="text" placeholder="Search models..." style="background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:5px 10px;font-size:.85em;width:200px" oninput="filterModal()">
<span id="modal-count" style="color:#8b949e;font-size:.8em"></span>
<button class="btn-del" onclick="closeModal()" style="margin-left:auto">&#215;</button>
</div>
<div class="modal-body" id="modal-body"></div>
<div class="modal-footer" id="modal-footer"></div>
</div>
</div>
<div id="cost-block" style="display:none">
<div class="section-title" style="display:flex;align-items:center;gap:10px">
<span style="flex:1">Live Status</span>
<span id="s-ts" class="sts"></span>
<select id="refresh-interval" onchange="setStatusInterval(+this.value)" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:2px 6px;font-size:.75em">
<option value="30">30s</option><option value="60" selected>1m</option><option value="300">5m</option><option value="0">off</option>
</select>
<button class="rbtn" onclick="loadStatus()">&#x21bb; Refresh</button>
<a href="#" id="cf-dash-link" target="_blank" style="color:#58a6ff;font-size:.75em;text-decoration:none">CF Dashboard &#x2197;</a>
</div>
<div class="cost-grid">
<div class="cost-card">
<div class="cct">Neuron Usage Today</div>
<div id="n-count" style="font-size:1.4em;font-weight:700;color:#f0f6fc">—</div>
<div class="nbar"><div class="nfill" id="n-fill"></div></div>
<div id="n-meta" style="font-size:.75em;color:#8b949e"></div>
<div id="n-models" style="margin-top:8px"></div>
</div>
<div class="cost-card">
<div class="cct">Monthly Costs</div>
<div id="c-rows"></div>
<div style="margin-top:12px"><div class="cct">Worker</div><div id="w-info" style="font-size:.85em"></div></div>
</div>
</div>
</div>
<div id="app">Loading...</div>
<div class="footer">Project and design <a href="https://github.com/noizo" target="_blank">noizo</a></div>
<script>
const AUTH="Bearer "+new URLSearchParams(location.search).get("key");
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
function escJs(s){return JSON.stringify(String(s))}
let cfg=null;
var kvMode=false;

async function load(){
  var r1=fetch("/api/config",{headers:{Authorization:AUTH}});
  var r2=fetch("/api/users",{headers:{Authorization:AUTH}});
  var res=await r1;
  if(!res.ok){document.getElementById("app").innerHTML="<p style='color:#da3633'>Auth failed. Check ?key= parameter.</p>";return}
  cfg=await res.json();
  if(!cfg.aliases)cfg.aliases=[];
  if(!cfg.voiceModels)cfg.voiceModels=[];
  if(!cfg.utilityModels)cfg.utilityModels=[];
  kvMode=cfg._meta&&cfg._meta.kv;
  delete cfg._meta;
  var ures=await r2;
  if(ures.ok)usersData=await ures.json();
  render();
  enrichModels();
}
async function enrichModels(){
  try{
    var r=await fetch("/api/discover",{headers:{Authorization:AUTH}});
    if(!r.ok)return;
    var d=await r.json();
    _discoverCache=d;
    var byPath={};
    for(var i=0;i<d.models.length;i++)byPath[d.models[i].name]=d.models[i];
    var changed=false;
    var lists=["chatModels","imageModels","voiceModels","utilityModels"];
    for(var li=0;li<lists.length;li++){
      var arr=cfg[lists[li]]||[];
      for(var j=0;j<arr.length;j++){
        var m=arr[j],src=byPath[m.path];
        if(!src)continue;
        if(src.contextWindow&&!m.contextWindow){m.contextWindow=src.contextWindow;changed=true}
        if(src.functionCalling&&!m.functionCalling){m.functionCalling=true;changed=true}
        if(src.reasoning&&!m.reasoning){m.reasoning=true;changed=true}
        if(src.vision&&!m.vision&&lists[li]==="chatModels"){m.vision=true;changed=true}
        if(src.inpainting&&!m.inpainting&&lists[li]==="imageModels"){m.inpainting=true;changed=true}
        if(src.beta&&!m.beta){m.beta=true;changed=true}
        if(src.deprecated&&!m.deprecated){m.deprecated=src.deprecated;changed=true}
        if(src.pricing&&!m.pricing){m.pricing=src.pricing;changed=true}
        if(src.description&&!m.description){m.description=src.description;changed=true}
      }
    }
    if(changed)render();
  }catch(e){}
}

function render(){
  let h='<div class="section-title">Models</div>';
  h+='<div class="columns">';
  h+='<div class="col">'+modelSection("Chat","chatModels")+'</div>';
  h+='<div class="col">'+modelSection("Image","imageModels")+'</div>';
  h+='<div class="col">'+modelSection("Voice","voiceModels")+'</div>';
  h+='<div class="col">'+modelSection("Utility","utilityModels")+'</div>';
  h+='</div>';
  h+='<div class="section-title" style="margin-top:32px">Config</div>';
  h+='<div class="two-col">';
  h+='<div>'+usersSection()+'</div>';
  h+='<div>'+aliasSection()+'</div>';
  h+='</div>';
  h+='<div style="display:flex;gap:10px;align-items:center;margin-top:20px">';
  h+='<span id="save-status" class="save-status"></span>';
  h+='<button class="add-btn" onclick="exportCfg()">Export JSON</button>';
  h+='</div>';
  if(!kvMode)h+='<div style="color:#d29922;font-size:.8em;margin-top:8px">&#9888; No KV namespace bound — changes live in memory only and are lost on cold start. Export JSON and apply via <code style="color:#d29922">wrangler kv:key put --namespace-id=&lt;id&gt; gateway-config config.json</code>.</div>';
  h+=apiRefSection();
  document.getElementById("app").innerHTML=h;
  filterTargets();
}

function priceBadge(p){
  if(!p)return '';
  if(p.input!=null&&p.output!=null)return '<span class="d-badge price" title="per million tokens">$'+esc(p.input)+' in · $'+esc(p.output)+' out</span>';
  if(p.input!=null)return '<span class="d-badge price" title="per million tokens">$'+esc(p.input)+' in</span>';
  if(p.unit)return '<span class="d-badge price">'+esc(p.unit)+'</span>';
  return '';
}
function modelSection(title,key){
  let h="<h2>"+title+"</h2>";
  h+='<div class="col-scroll">';
  cfg[key].forEach((m,i)=>{
    h+='<div class="card">';
    h+='<div class="arrows">';
    h+="<button onclick=\\"move('"+key+"',"+i+",-1)\\">&#9650;</button>";
    h+="<button onclick=\\"move('"+key+"',"+i+",1)\\">&#9660;</button>";
    h+='</div><div class="info">';
    h+='<div class="name">'+esc(m.label||m.id)+'</div>';
    h+='<div class="path">'+esc(m.path)+'</div>';
    h+='<div class="meta">';
    if(m.vision)h+='<span class="d-badge vision">vision</span>';
    if(m.inpainting)h+='<span class="d-badge inpaint">inpainting</span>';
    if(m.contextWindow)h+='<span class="d-badge ctx">ctx:'+Math.round(m.contextWindow/1024)+'k</span>';
    if(m.kind)h+='<span class="d-badge kind">'+m.kind+'</span>';
    if(m.functionCalling)h+='<span class="d-badge fn">fn_call</span>';
    if(m.reasoning)h+='<span class="d-badge reason">reasoning</span>';
    if(m.beta)h+='<span class="d-badge beta">BETA</span>';
    if(m.deprecated)h+='<span class="d-badge dep">deprecated</span>';
    h+=priceBadge(m.pricing);
    h+='</div>';
    h+='</div>';
    h+="<button class=\\"d-info-btn\\" onmouseenter=\\"showModelInfo('"+key+"',"+i+",event)\\" onmouseleave=\\"hideInfo()\\">i</button>";
    h+="<button class=\\"del\\" onclick=\\"delModel('"+key+"',"+i+")\\">&#215;</button>";
    h+='</div>';
  });
  h+='</div>';
  h+="<button class=\\"add-btn\\" onclick=\\"openDiscover('"+key+"')\\" style=\\"width:100%;margin-top:auto;flex-shrink:0\\">+ Add</button>";
  return h;
}

function aliasSection(){
  let h='<div>';
  h+='<h2>Aliases (spoofed names)</h2>';
  h+='<p style="color:#8b949e;font-size:.8em;margin-bottom:10px">Aliases always work for all keys. Clients send alias names (e.g. <code>gpt-4o</code>), gateway resolves them to real models.</p>';
  const allModels=[...cfg.chatModels.map(m=>({id:m.id,t:"chat"})),...cfg.imageModels.map(m=>({id:m.id,t:"image"})),(cfg.voiceModels||[]).map(m=>({id:m.id,t:"voice"}))].flat();
  cfg.aliases.forEach((a,i)=>{
    h+='<div class="alias-row">';
    h+='<span class="spoof">'+esc(a.name)+'</span>';
    h+='<span class="arrow-icon">&rarr;</span>';
    h+='<select onchange="setAlias('+i+',this.value)">';
    const pool=allModels.filter(m=>m.t===a.type);
    pool.forEach(m=>{
      h+='<option value="'+esc(m.id)+'"'+(m.id===a.target?' selected':'')+'>'+esc(m.id)+'</option>';
    });
    h+='</select>';
    h+='<span class="type-badge">'+a.type+'</span>';
    h+='<button class="del" onclick="delAlias('+i+')">&times;</button>';
    h+='</div>';
  });
  h+='<div class="add-row">';
  h+='<input id="newAlias" placeholder="e.g. gpt-4o">';
  h+='<select id="newType" onchange="filterTargets()"><option value="chat">chat</option><option value="image">image</option><option value="voice">voice</option></select>';
  h+='<select id="newTarget"></select>';
  h+='<button class="add-btn" onclick="addAlias()">+ Add</button>';
  h+='</div></div>';
  return h;
}

function filterTargets(){
  var ts=document.getElementById("newType");
  if(!ts)return;
  var t=ts.value,sel=document.getElementById("newTarget");
  sel.innerHTML="";
  var pool=t==="chat"?cfg.chatModels:t==="image"?cfg.imageModels:(cfg.voiceModels||[]);
  pool.forEach(function(m){sel.innerHTML+='<option value="'+esc(m.id)+'">'+esc(m.id)+'</option>'});
}
function move(key,idx,dir){
  const arr=cfg[key],to=idx+dir;
  if(to<0||to>=arr.length)return;
  [arr[idx],arr[to]]=[arr[to],arr[idx]];
  render();autoSave();
}
function delModel(key,idx){cfg[key].splice(idx,1);render();autoSave()}
var _discoverCache=null;
var _modalCat=null;
var _modalSearch="";
var catLabels={chatModels:"Chat",imageModels:"Image",voiceModels:"Voice",utilityModels:"Utility"};
async function openDiscover(cat){
  _modalCat=cat;_modalSearch="";
  var modal=document.getElementById("modal");
  document.getElementById("modal-title").textContent="Add "+catLabels[cat]+" Model";
  document.getElementById("modal-search").value="";
  modal.classList.add("open");
  if(_discoverCache){renderModal();return}
  document.getElementById("modal-body").innerHTML='<p style="color:#8b949e;padding:20px 0">Loading models from Cloudflare...</p>';
  document.getElementById("modal-footer").innerHTML="";
  document.getElementById("modal-count").textContent="";
  var r=await fetch("/api/discover",{headers:{Authorization:AUTH}});
  if(!r.ok){document.getElementById("modal-body").innerHTML='<p style="color:#da3633">Discovery failed</p>';return}
  _discoverCache=await r.json();
  renderModal();
}
function closeModal(){document.getElementById("modal").classList.remove("open");hideInfo()}
function filterModal(){_modalSearch=(document.getElementById("modal-search").value||"").toLowerCase();renderModal()}
function getModalItems(){
  if(!_discoverCache||!_modalCat)return[];
  var items=_discoverCache.models.filter(function(m){return m.category===_modalCat});
  if(_modalSearch)items=items.filter(function(m){return m.id.toLowerCase().indexOf(_modalSearch)>=0||m.name.toLowerCase().indexOf(_modalSearch)>=0||(m.description||"").toLowerCase().indexOf(_modalSearch)>=0});
  return items;
}
function renderModal(){
  var items=getModalItems();
  var existingPaths=new Set();
  for(var list of [cfg.chatModels,cfg.imageModels,cfg.voiceModels,cfg.utilityModels])
    for(var m of list||[])existingPaths.add(m.path);
  var addedCount=0,h="";
  for(var i=0;i<items.length;i++){
    var m=items[i];
    var added=existingPaths.has(m.name);
    if(added)addedCount++;
    h+='<div class="card">';
    h+='<div class="info">';
    h+='<div class="name">'+esc(m.id)+'</div>';
    h+='<div class="path">'+esc(m.name)+'</div>';
    h+='<div class="meta">';
    if(m.beta)h+='<span class="d-badge beta">BETA</span>';
    if(m.vision)h+='<span class="d-badge vision">vision</span>';
    if(m.functionCalling)h+='<span class="d-badge fn">fn_call</span>';
    if(m.reasoning)h+='<span class="d-badge reason">reasoning</span>';
    if(m.contextWindow)h+='<span class="d-badge ctx">ctx:'+Math.round(m.contextWindow/1024)+'k</span>';
    if(m.inpainting)h+='<span class="d-badge inpaint">inpainting</span>';
    h+=priceBadge(m.pricing);
    if(m.kind)h+='<span class="d-badge kind">'+m.kind+'</span>';
    if(m.deprecated)h+='<span class="d-badge dep">EOL</span>';
    h+='</div></div>';
    h+="<button class=\\"d-info-btn\\" onmouseenter=\\"showDiscoverInfo("+i+",event)\\" onmouseleave=\\"hideInfo()\\">i</button>";
    h+='<label class="toggle"><input type="checkbox" '+(added?"checked":"")+" onchange=\\"toggleDiscover("+i+",this.checked)\\"><span class=\\"slider\\"></span></label>";
    h+='</div>';
  }
  if(!items.length)h='<p style="color:#8b949e;padding:20px 0;text-align:center">No models found'+(_modalSearch?' for "'+esc(_modalSearch)+'"':'')+'</p>';
  document.getElementById("modal-body").innerHTML=h;
  document.getElementById("modal-count").textContent=items.length+" models · "+addedCount+" added";
  var dc=_discoverCache;
  document.getElementById("modal-footer").innerHTML='Source: <a href="'+(dc.dashboard||"#")+'" target="_blank">Workers AI Dashboard</a> · <a href="https://developers.cloudflare.com/workers-ai/platform/pricing/" target="_blank">Full pricing table</a>';
}
function showDiscoverInfo(idx,ev){
  var m=getModalItems()[idx];if(!m)return;
  var tip=document.getElementById("d-tip");if(!tip)return;
  tip.innerHTML='<div class="dt-title">'+esc(m.id)+'</div><div class="dt-path">'+esc(m.name)+'</div>'+(m.description?esc(m.description):'<em style="color:#8b949e">No description</em>');
  positionTip(tip,ev);
}
function toggleDiscover(idx,on){
  var m=getModalItems()[idx];if(!m)return;
  var cat=_modalCat;
  if(on){
    if(cfg[cat].some(function(x){return x.path===m.name}))return;
    var entry={id:m.id,path:m.name,label:m.id,description:m.description||""};
    if(m.beta)entry.beta=true;
    if(m.deprecated)entry.deprecated=m.deprecated;
    if(m.functionCalling)entry.functionCalling=true;
    if(m.reasoning)entry.reasoning=true;
    if(m.pricing)entry.pricing=m.pricing;
    if(cat==="chatModels"){entry.vision=!!m.vision;entry.contextWindow=m.contextWindow||32768}
    if(cat==="imageModels"){entry.maxDim=1024;entry.multipart=false;entry.inpainting=!!m.inpainting}
    if(cat==="voiceModels")entry.kind=m.kind||"stt";
    if(cat==="utilityModels")entry.kind=m.kind||"other";
    cfg[cat].push(entry);
  }else{
    cfg[cat]=cfg[cat].filter(function(x){return x.path!==m.name});
  }
  render();
  autoSave();
}
function setAlias(idx,val){cfg.aliases[idx].target=val;autoSave()}
function delAlias(idx){cfg.aliases.splice(idx,1);render();autoSave()}
function addAlias(){
  const name=document.getElementById("newAlias").value.trim();
  const type=document.getElementById("newType").value;
  const target=document.getElementById("newTarget").value;
  if(!name){toast("Enter alias name",true);return}
  if(cfg.aliases.some(a=>a.name===name)){toast("Alias exists",true);return}
  cfg.aliases.push({name,target,type});
  render();autoSave();
}

var _saveTimer=null;
function autoSave(){
  var el=document.getElementById("save-status");
  if(el){el.textContent="Unsaved changes...";el.className="save-status saving"}
  if(_saveTimer)clearTimeout(_saveTimer);
  _saveTimer=setTimeout(doSave,600);
}
async function doSave(){
  var el=document.getElementById("save-status");
  if(el){el.textContent="Saving...";el.className="save-status saving"}
  try{
    const r=await fetch("/api/config",{
      method:"POST",
      headers:{Authorization:AUTH,"Content-Type":"application/json"},
      body:JSON.stringify(cfg)
    });
    const d=await r.json();
    if(d.ok){
      if(el){el.textContent="\\u2713 Saved"+(d.storage==="memory"?" (memory)":"");el.className="save-status saved"}
      setTimeout(function(){if(el)el.textContent=""},3000);
    }else{
      if(el){el.textContent="\\u2717 Save failed";el.className="save-status error"}
      toast("Error: "+(d.error||"unknown"),true);
    }
  }catch(e){
    if(el){el.textContent="\\u2717 Network error";el.className="save-status error"}
  }
}

function toast(msg,err){
  const t=document.getElementById("toast");
  t.textContent=msg;
  t.className="toast"+(err?" err":"");
  t.style.display="block";
  setTimeout(()=>t.style.display="none",3000);
}

function fmtN(v){if(v>=1e5)return(v/1e3).toFixed(0)+"k";if(v>=1e3)return(v/1e3).toFixed(1)+"k";return v%1===0?String(v):v.toFixed(1)}
async function loadStatus(){
  try{
    const r=await fetch("/api/status",{headers:{Authorization:AUTH}});
    if(!r.ok)return;
    const d=await r.json();
    var n=d.neurons;
    var pct=Math.min(200,(n.total/n.included)*100);
    document.getElementById("n-fill").style.width=Math.min(100,pct)+"%";
    document.getElementById("n-fill").className="nfill"+(pct>100?" over":pct>80?" warn":"");
    document.getElementById("n-count").textContent=fmtN(n.total)+" / "+fmtN(n.included);
    var meta=n.overage>0?fmtN(n.overage)+" over limit · $"+n.overage_cost_usd.toFixed(2)+" today":fmtN(n.included-n.total)+" remaining";
    document.getElementById("n-meta").textContent=meta;
    var mh="";
    for(var i=0;i<n.by_model.length;i++){
      var m=n.by_model[i];
      mh+='<div class="mr"><span>'+esc(m.model)+"</span><span>"+m.requests+" req</span><span>"+fmtN(m.neurons)+" n</span></div>";
    }
    if(!n.by_model.length)mh='<div class="mr"><span style="color:#8b949e">No inference today</span></div>';
    document.getElementById("n-models").innerHTML=mh;
    var c=d.costs;
    var ch='<div class="cr"><span>Workers plan</span><span>$'+c.base_plan_usd.toFixed(2)+"</span></div>";
    ch+='<div class="cr"><span>Neurons ('+fmtN(c.neurons_overage)+' over)</span><span>$'+c.neurons_cost_usd.toFixed(2)+"</span></div>";
    ch+='<div class="cr sep"><span>Month to date</span><span>$'+c.month_to_date_usd.toFixed(2)+"</span></div>";
    ch+='<div class="cr"><span>Projected (day '+c.days_elapsed+"/"+c.days_in_month+')</span><span>~$'+c.projected_month_usd.toFixed(2)+"</span></div>";
    document.getElementById("c-rows").innerHTML=ch;
    var w=d.worker;
    var ep=w.invocations>0?((w.errors/w.invocations)*100).toFixed(1)+"%":"0%";
    document.getElementById("w-info").innerHTML=w.name+"<br>"+w.invocations+" requests · "+w.errors+" errors ("+ep+")";
    document.getElementById("s-ts").textContent="Updated: "+d.timestamp.slice(0,16).replace("T"," ")+" UTC";
    document.getElementById("cost-block").style.display="block";
    var dl=document.getElementById("cf-dash-link");
    if(dl&&d.account_id)dl.href="https://dash.cloudflare.com/"+d.account_id+"/ai/workers-ai";
  }catch(e){}}

var usersData=null;
function userCard(u,rl){
  var hjid=esc(escJs(u.id));
  var h='<div class="card" style="flex-wrap:wrap;gap:6px">';
  h+='<div class="info" style="flex:1;min-width:0">';
  h+='<input class="inline-name" value="'+esc(u.name)+'" data-uid="'+esc(u.id)+'" onblur="renameKey(this)" onkeydown="if(event.key===&#39;Enter&#39;)this.blur()" style="background:transparent;border:none;border-bottom:1px solid transparent;color:#f0f6fc;font-weight:600;font-size:.95em;padding:0 0 1px;width:100%;outline:none" onfocus="this.style.borderBottomColor=&#39;#58a6ff&#39;" />';
  h+='<div class="path">'+esc(u.source)+' · '+u.rpm+' RPM';
  if(rl)h+=' · '+rl.used+'/'+u.rpm+' used';
  if(u.keyPreview)h+=' · key: '+esc(u.keyPreview);
  if(u.created)h+=' · '+esc(u.created);
  h+='</div></div>';
  h+='<span class="spoof-lbl" title="ON: /v1/models returns ONLY alias names (gpt-4o, dall-e-3, etc.) — real backend models are hidden. Use this for clients that expect OpenAI-compatible model names.&#10;OFF: /v1/models returns real Cloudflare model IDs.&#10;Aliases always resolve in both modes.">Spoof aliases</span>';
  h+='<label class="toggle"><input type="checkbox" '+(u.spoofed?"checked":"");
  h+=" onchange=\\"toggleSpoof("+hjid+")\\"><span class=\\"slider\\"></span></label>";
  if(u.source==="kv")h+="<button class=\\"del\\" onclick=\\"deleteUser("+hjid+")\\">\\u00d7</button>";
  h+='</div>';
  return h;
}
function usersSection(){
  if(!usersData)return'<div style="color:#8b949e;margin:16px 0">Users unavailable</div>';
  var d=usersData,h='<h2>API Keys</h2>';
  for(var i=0;i<d.env_users.length;i++){h+=userCard(d.env_users[i],d.rate_limits[d.env_users[i].id]);}
  for(var i=0;i<d.kv_users.length;i++){h+=userCard(d.kv_users[i],d.rate_limits[d.kv_users[i].id]);}
  h+='<div class="add-row" style="margin-top:12px"><input id="new-uid" placeholder="user name">';
  h+='<input id="new-rpm" type="number" value="30" style="width:80px" placeholder="RPM">';
  h+='<button class="add-btn" onclick="createUser()">+ Generate Key</button></div>';
  h+='<div id="key-display" style="display:none;margin-top:12px;padding:12px;background:#161b22;border:1px solid #238636;border-radius:8px">';
  h+='<div style="font-size:.9em;font-weight:600;color:#238636;margin-bottom:6px">New key — copy now, shown once only</div>';
  h+='<div style="display:flex;gap:8px;align-items:center"><code id="new-key" style="flex:1;word-break:break-all;color:#f0f6fc"></code>';
  h+='<button class="add-btn" onclick="copyKey()">Copy</button></div></div>';
  return h;
}
function apiRefSection(){
  var h='<details style="margin-top:24px"><summary style="cursor:pointer;color:#58a6ff;font-weight:600;font-size:1em">API Reference</summary><div style="font-size:.85em;margin-top:12px">';
  h+='<div class="card" style="flex-direction:column;align-items:stretch;gap:8px">';
  h+='<div><span style="color:#8b949e">Base URL</span><br><code style="color:#58a6ff">https://'+location.host+'/v1</code></div>';
  h+='<div><span style="color:#8b949e">Authentication</span><br><code style="color:#58a6ff">Authorization: Bearer &lt;key&gt;</code></div></div>';
  h+='<div class="card" style="flex-direction:column;align-items:stretch;gap:6px">';
  h+='<div style="color:#8b949e;font-weight:600">Model selection</div>';
  h+='<div>Short name: <code style="color:#58a6ff">"qwen3-30b-a3b-fp8"</code></div>';
  h+='<div>Full CF path: <code style="color:#58a6ff">"@cf/qwen/qwen3-30b-a3b-fp8"</code></div>';
  h+='<div>Alias: <code style="color:#58a6ff">"gpt-4o"</code> <span style="color:#8b949e">(always resolves for all keys)</span></div></div>';
  h+='<div class="card" style="flex-direction:column;align-items:stretch;gap:6px">';
  h+='<div style="color:#8b949e;font-weight:600">Spoof aliases</div>';
  h+='<div><b style="color:#238636">ON</b> — <code>GET /v1/models</code> returns <b>only</b> alias names (<code>gpt-4o</code>, <code>dall-e-3</code>, …). Real backend models are hidden. Use for clients that expect OpenAI model names.</div>';
  h+='<div><b style="color:#8b949e">OFF</b> — <code>GET /v1/models</code> returns real Cloudflare model IDs. Default.</div>';
  h+='<div style="color:#8b949e">Toggle per key in API Keys above. Aliases resolve in requests regardless of this setting.</div></div>';
  h+='<div class="card" style="flex-direction:column;align-items:stretch;gap:3px">';
  h+='<div style="color:#8b949e;font-weight:600;margin-bottom:4px">Endpoints</div>';
  var eps=[["POST /v1/chat/completions","Chat completions (streaming supported)"],["POST /v1/images/generations","Image generation"],["POST /v1/images/edits","Inpainting (multipart)"],["POST /v1/embeddings","Text embeddings"],["POST /v1/audio/transcriptions","Speech-to-text (multipart)"],["POST /v1/audio/translations","Audio translation (multipart)"],["POST /v1/audio/speech","Text-to-speech"],["POST /v1/translations","Text translation"],["POST /v1/moderations","Content moderation"],["GET /v1/models","List available models"],["GET /status","ASCII status dashboard"],["GET /config?key=&lt;key&gt;","Config panel (this page)"],["GET /api/discover","Browse Cloudflare model catalog"],["GET /api/status","Live status + costs (JSON)"],["GET /api/config","Current config (JSON)"],["GET /api/users","API key info (JSON)"]];
  for(var j=0;j<eps.length;j++){h+='<div style="display:flex;gap:12px"><code style="color:#58a6ff;min-width:280px;font-size:.85em">'+eps[j][0]+'</code><span style="color:#8b949e">'+eps[j][1]+'</span></div>';}
  h+='</div></div></details>';
  return h;
}
async function createUser(){
  var id=document.getElementById("new-uid").value.trim();
  var rpm=parseInt(document.getElementById("new-rpm").value)||30;
  if(!id){toast("Enter user name",true);return}
  var r=await fetch("/api/users",{method:"POST",headers:{Authorization:AUTH,"Content-Type":"application/json"},body:JSON.stringify({action:"create",id:id,rpm:rpm})});
  var d=await r.json();
  if(d.error){toast(d.error,true);return}
  document.getElementById("new-key").textContent=d.key;
  document.getElementById("key-display").style.display="block";
  document.getElementById("new-uid").value="";
  toast("User "+id+" created!",false);
  var r2=await fetch("/api/users",{headers:{Authorization:AUTH}});if(r2.ok)usersData=await r2.json();render();
}
async function deleteUser(id){
  if(!confirm("Delete user "+id+"?"))return;
  var r=await fetch("/api/users",{method:"POST",headers:{Authorization:AUTH,"Content-Type":"application/json"},body:JSON.stringify({action:"delete",id:id})});
  var d=await r.json();
  if(d.ok){toast("Deleted",false);var r2=await fetch("/api/users",{headers:{Authorization:AUTH}});if(r2.ok)usersData=await r2.json();render();}
  else toast(d.error||"Failed",true);
}
async function toggleSpoof(id){
  var r=await fetch("/api/users",{method:"POST",headers:{Authorization:AUTH,"Content-Type":"application/json"},body:JSON.stringify({action:"toggle_spoof",id:id})});
  var d=await r.json();
  if(d.ok){
    if(!cfg.spoofedKeys)cfg.spoofedKeys=[];
    if(d.spoofed){if(cfg.spoofedKeys.indexOf(id)<0)cfg.spoofedKeys.push(id)}
    else{cfg.spoofedKeys=cfg.spoofedKeys.filter(function(k){return k!==id})}
    toast(d.spoofed?"Spoof aliases ON for "+id:"Spoof aliases OFF for "+id,false);
    var r2=await fetch("/api/users",{headers:{Authorization:AUTH}});if(r2.ok)usersData=await r2.json();render();
  }else toast(d.error||"Failed",true);
}
async function renameKey(el){
  var uid=el.dataset.uid;var name=el.value.trim();
  if(!name){el.value=uid;name=uid;}
  var prev=usersData?[].concat(usersData.env_users,usersData.kv_users).find(function(u){return u.id===uid}):null;
  if(prev&&prev.name===name)return;
  var r=await fetch("/api/users",{method:"POST",headers:{Authorization:AUTH,"Content-Type":"application/json"},body:JSON.stringify({action:"rename_key",id:uid,name:name})});
  var d=await r.json();
  if(d.ok){toast("Renamed",false);var r2=await fetch("/api/users",{headers:{Authorization:AUTH}});if(r2.ok)usersData=await r2.json();}
  else{toast(d.error||"Failed",true);if(prev)el.value=prev.name;}
}
function copyKey(){navigator.clipboard.writeText(document.getElementById("new-key").textContent);toast("Copied!",false)}
function exportCfg(){
  var blob=new Blob([JSON.stringify(cfg,null,2)],{type:"application/json"});
  var a=document.createElement("a");a.href=URL.createObjectURL(blob);
  a.download="cng-config.json";a.click();URL.revokeObjectURL(a.href);
}

function showModelInfo(key,idx,ev){
  var m=cfg[key][idx];if(!m)return;
  var tip=document.getElementById("d-tip");if(!tip)return;
  var h='<div class="dt-title">'+esc(m.label||m.id)+'</div><div class="dt-path">'+esc(m.path)+'</div>';
  if(m.description)h+=esc(m.description);
  else h+='<em style="color:#8b949e">No description</em>';
  var details=[];
  if(m.maxDim)details.push("Max: "+m.maxDim+"px");
  if(m.multipart)details.push("Multipart upload");
  if(m.inpainting)details.push("Inpainting");
  if(m.contextWindow)details.push("Context: "+m.contextWindow.toLocaleString()+" tokens");
  if(details.length)h+='<div style="margin-top:6px;color:#58a6ff;font-size:.9em">'+details.join(" · ")+'</div>';
  tip.innerHTML=h;
  positionTip(tip,ev);
}
function positionTip(tip,ev){
  var r=ev.target.getBoundingClientRect();
  tip.style.left=Math.min(r.left,window.innerWidth-380)+"px";
  tip.style.top=(r.bottom+6)+"px";
  tip.style.display="block";
}
function hideInfo(){var tip=document.getElementById("d-tip");if(tip)tip.style.display="none";}

var statusInterval=null;
function setStatusInterval(sec){
  if(statusInterval)clearInterval(statusInterval);
  statusInterval=sec>0?setInterval(loadStatus,sec*1000):null;
}

load();
loadStatus();
setStatusInterval(60);
</script>
</body>
</html>`;

