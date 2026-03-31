const MODEL_PATH_RE = /^@?[a-zA-Z0-9._\/-]+$/;

class AIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 502;
  }
}

function validateModel(model) {
  if (!MODEL_PATH_RE.test(model)) {
    throw new AIError("Invalid model identifier", 400);
  }
}

function restUrl(env, model) {
  validateModel(model);
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`;
}

function restHeaders(env, contentType) {
  const h = { Authorization: `Bearer ${env.CF_API_TOKEN}` };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

async function unwrapRest(resp) {
  const data = await resp.json().catch(() => null);
  if (!resp.ok || data?.errors?.length) {
    throw new AIError(data?.errors?.[0]?.message || "AI request failed", resp.status);
  }
  return data.result;
}

function safeErrorMessage(text, fallback) {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed?.errors?.[0]?.message || fallback;
  } catch {
    return fallback;
  }
}

async function toUint8Array(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof ReadableStream) {
    const reader = raw.getReader();
    const parts = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const total = parts.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of parts) { out.set(c, off); off += c.length; }
    return out;
  }
  return null;
}

export async function runModel(env, model, inputs) {
  if (env.AI) {
    return env.AI.run(model, inputs);
  }
  const resp = await fetch(restUrl(env, model), {
    method: "POST",
    headers: restHeaders(env, "application/json"),
    body: JSON.stringify(inputs),
  });
  return unwrapRest(resp);
}

export async function runModelStream(env, model, inputs) {
  if (env.AI) {
    return env.AI.run(model, { ...inputs, stream: true });
  }
  const resp = await fetch(restUrl(env, model), {
    method: "POST",
    headers: restHeaders(env, "application/json"),
    body: JSON.stringify({ ...inputs, stream: true }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new AIError(safeErrorMessage(text, "Stream request failed"), resp.status);
  }
  return resp.body;
}

export async function runModelRaw(env, model, body, contentType) {
  if (env.AI) {
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
      return env.AI.run(model, { audio: bytes });
    }
    return env.AI.run(model, body);
  }
  const resp = await fetch(restUrl(env, model), {
    method: "POST",
    headers: restHeaders(env, contentType),
    body,
  });
  return unwrapRest(resp);
}

export async function runImageJson(env, model, inputs) {
  if (env.AI) {
    try {
      const raw = await env.AI.run(model, inputs);
      const bytes = await toUint8Array(raw);
      if (bytes) return bytes.length > 0 ? { imageBytes: bytes } : null;
      return raw;
    } catch {
      if (!env.CF_API_TOKEN) throw new AIError("AI binding failed, no REST fallback", 502);
    }
  }
  const resp = await fetch(restUrl(env, model), {
    method: "POST",
    headers: restHeaders(env, "application/json"),
    body: JSON.stringify(inputs),
  });
  const ct = resp.headers.get("content-type") || "";
  if (ct.startsWith("image/")) {
    const buf = await resp.arrayBuffer();
    return buf.byteLength > 0 ? { imageBytes: new Uint8Array(buf) } : null;
  }
  return unwrapRest(resp);
}

export async function runImageMultipart(env, model, formResp) {
  const ct = formResp.headers.get("content-type");

  if (env.AI) {
    try {
      const body = new Uint8Array(await formResp.clone().arrayBuffer());
      const raw = await env.AI.run(model, { multipart: { body, contentType: ct } });
      const bytes = await toUint8Array(raw);
      if (bytes) return bytes.length > 0 ? { imageBytes: bytes } : null;
      if (typeof raw === "string") return { image: raw };
      return raw;
    } catch {
      // Binding failed for multipart, fall through to REST
    }
  }

  if (!env.CF_API_TOKEN) throw new AIError("No REST credentials for multipart fallback", 502);
  const resp = await fetch(restUrl(env, model), {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": ct },
    body: formResp.body,
  });
  const rct = resp.headers.get("content-type") || "";
  if (rct.startsWith("image/")) {
    const buf = await resp.arrayBuffer();
    return buf.byteLength > 0 ? { imageBytes: new Uint8Array(buf) } : null;
  }
  return unwrapRest(resp);
}

export async function runModelBinary(env, model, inputs) {
  if (env.AI) {
    return env.AI.run(model, inputs);
  }
  const resp = await fetch(restUrl(env, model), {
    method: "POST",
    headers: restHeaders(env, "application/json"),
    body: JSON.stringify(inputs),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new AIError(safeErrorMessage(errText, "Binary request failed"), resp.status);
  }
  return resp.body;
}

export { AIError };
