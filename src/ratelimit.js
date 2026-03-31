// Per-isolate in-memory rate limiting. Each Worker isolate maintains its own
// counters — limits are best-effort, not globally enforced across POPs.
export const DEFAULT_RPM = 60;
const WINDOW_MS = 60_000;
const MAX_BUCKETS = 500;
const MAX_HEALTH_ENTRIES = 200;

const counters = new Map();

function windowId() {
  return Math.floor(Date.now() / WINDOW_MS);
}

function bucket(userId) {
  const wid = windowId();
  let b = counters.get(userId);
  if (!b || b.wid !== wid) {
    if (counters.size >= MAX_BUCKETS) {
      const oldest = counters.keys().next().value;
      counters.delete(oldest);
    }
    b = { wid, count: 0, categories: {}, models: {} };
    counters.set(userId, b);
  }
  return b;
}

export function resolveLimit(auth, cfg) {
  let v;
  if (cfg.users) {
    const u = cfg.users.find(x => x.id === auth.id);
    if (u && u.rpm != null) v = u.rpm;
  }
  if (v == null) {
    const rl = cfg.rateLimits || {};
    if (rl[auth.id] != null) v = rl[auth.id];
    else if (rl[auth.role] != null) v = rl[auth.role];
  }
  if (v == null) return DEFAULT_RPM;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : DEFAULT_RPM;
}

export function checkRate(auth, cfg, category) {
  const limit = resolveLimit(auth, cfg);
  const b = bucket(auth.id);
  const reset = (b.wid + 1) * WINDOW_MS;

  if (limit === 0) {
    b.count++;
    if (category) b.categories[category] = (b.categories[category] || 0) + 1;
    return { allowed: true, limit: 0, remaining: 0, reset: 0 };
  }

  if (b.count >= limit) {
    return { allowed: false, limit, remaining: 0, reset };
  }

  b.count++;
  if (category) b.categories[category] = (b.categories[category] || 0) + 1;
  return { allowed: true, limit, remaining: Math.max(0, limit - b.count), reset };
}

export function recordModel(userId, model) {
  const b = bucket(userId);
  const short = (model.includes("/") ? model.split("/").pop() : model).slice(0, 80);
  if (Object.keys(b.models).length < 100) b.models[short] = (b.models[short] || 0) + 1;
}

export function getRateStats() {
  const wid = windowId();
  const stats = {};
  for (const [userId, b] of counters) {
    if (b.wid !== wid) continue;
    stats[userId] = { count: b.count, categories: { ...b.categories }, models: { ...b.models } };
  }
  return stats;
}

const modelHealth = new Map();
const HEALTH_KV_KEY = "_model_health";
const HEALTH_TTL = 300_000;

function shortModel(model) {
  return (model.includes("/") ? model.split("/").pop() : model).slice(0, 80);
}

export function reportModelError(model, env) {
  const short = shortModel(model);
  const now = Date.now();
  let h = modelHealth.get(short);
  if (!h) {
    if (modelHealth.size >= MAX_HEALTH_ENTRIES) {
      const oldest = modelHealth.keys().next().value;
      modelHealth.delete(oldest);
    }
    h = { fails: 0, lastFail: 0, lastOk: 0 };
    modelHealth.set(short, h);
  }
  h.fails++;
  h.lastFail = now;
  if (env?.CONFIG) persistHealth(env.CONFIG).catch(() => {});
}

export function reportModelOk(model, env) {
  const short = shortModel(model);
  const h = modelHealth.get(short);
  if (h) { h.fails = 0; h.lastOk = Date.now(); }
  if (env?.CONFIG) persistHealth(env.CONFIG).catch(() => {});
}

async function persistHealth(kv) {
  const out = {};
  const now = Date.now();
  for (const [model, h] of modelHealth) {
    if (h.fails > 0 && now - h.lastFail < HEALTH_TTL) {
      out[model] = { fails: h.fails, lastFail: h.lastFail };
    }
  }
  if (Object.keys(out).length > 0) {
    await kv.put(HEALTH_KV_KEY, JSON.stringify(out), { expirationTtl: 300 });
  } else {
    await kv.delete(HEALTH_KV_KEY);
  }
}

export async function getModelHealth(env) {
  const out = {};
  const now = Date.now();
  for (const [model, h] of modelHealth) {
    if (h.fails > 0 && now - h.lastFail < HEALTH_TTL) {
      out[model] = { fails: h.fails, lastFail: h.lastFail };
    }
  }
  if (env?.CONFIG) {
    try {
      const raw = await env.CONFIG.get(HEALTH_KV_KEY);
      if (raw) {
        const kv = JSON.parse(raw);
        for (const [model, h] of Object.entries(kv)) {
          if (now - h.lastFail < HEALTH_TTL) {
            if (!out[model] || h.lastFail > out[model].lastFail) {
              out[model] = h;
            }
          }
        }
      }
    } catch {}
  }
  return out;
}

export function inferenceCategory(pathname) {
  if (pathname.includes("/chat/completions")) return "chat";
  if (pathname.includes("/images/")) return "image";
  if (pathname.includes("/audio/")) return "audio";
  if (pathname.includes("/embeddings")) return "embed";
  if (pathname.includes("/moderations")) return "mod";
  if (pathname.includes("/translations")) return "translate";
  return null;
}
