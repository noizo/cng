import { hashKey } from "./auth.js";
import { loadConfig, setConfigCache } from "./config.js";
import { getRateStats, resolveLimit } from "./ratelimit.js";

const ENV_USERS_DEF = [
  { id: "admin", envKey: "API_KEY", role: "admin" },
  { id: "key2", envKey: "API_KEY_2", role: "client" },
];

const RESERVED_IDS = new Set(ENV_USERS_DEF.map((u) => u.id));

export async function handleGetUsers(env) {
  const config = await loadConfig(env);
  const spoofed = config.spoofedKeys || [];
  const names = config.keyNames || {};
  const stats = getRateStats();

  const envUsers = ENV_USERS_DEF.map(({ id, role }) => ({
    id,
    name: names[id] || id,
    source: "env",
    spoofed: spoofed.includes(id),
    role,
    rpm: resolveLimit({ id, role }, config),
    rate: stats[id] || { count: 0, categories: {}, models: {} },
  }));
  const kvUsers = (config.users || []).map((u) => ({
    id: u.id,
    name: names[u.id] || u.id,
    keyPreview: u.keyPreview || "****",
    created: u.created || "",
    source: "kv",
    spoofed: spoofed.includes(u.id),
    role: u.role || "client",
    rpm: resolveLimit({ id: u.id, role: u.role || "client" }, config),
    rate: stats[u.id] || { count: 0, categories: {}, models: {} },
  }));
  return Response.json({ env_users: envUsers, kv_users: kvUsers, kv_available: !!env.CONFIG });
}

export async function handleUserAction(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const config = await loadConfig(env);
  if (!config.users) config.users = [];

  async function persist() {
    if (env.CONFIG) {
      try {
        await env.CONFIG.put("gateway-config", JSON.stringify(config));
      } catch {
        return null;
      }
    }
    setConfigCache(config);
    return env.CONFIG ? "kv" : "memory";
  }

  if (body.action === "set_rpm") {
    const rpm = parseInt(body.rpm, 10);
    if (isNaN(rpm) || rpm < 0) return Response.json({ error: "Invalid RPM value" }, { status: 400 });
    const kvUser = config.users.find((u) => u.id === body.id);
    if (kvUser) {
      kvUser.rpm = rpm;
    } else {
      if (!config.rateLimits) config.rateLimits = {};
      config.rateLimits[body.id] = rpm;
    }
    const storage = await persist();
    if (!storage) return Response.json({ error: "Failed to persist change" }, { status: 503 });
    return Response.json({ ok: true, rpm, storage });
  }

  if (body.action === "toggle_spoof") {
    if (!config.spoofedKeys) config.spoofedKeys = [];
    const idx = config.spoofedKeys.indexOf(body.id);
    if (idx >= 0) config.spoofedKeys.splice(idx, 1);
    else config.spoofedKeys.push(body.id);
    const storage = await persist();
    if (!storage) return Response.json({ error: "Failed to persist change" }, { status: 503 });
    return Response.json({ ok: true, spoofed: config.spoofedKeys.includes(body.id), storage });
  }

  if (body.action === "rename_key") {
    if (!body.id || typeof body.name !== "string") return Response.json({ error: "Missing id or name" }, { status: 400 });
    if (!config.keyNames) config.keyNames = {};
    const trimmed = body.name.trim().slice(0, 128);
    if (trimmed && trimmed !== body.id) config.keyNames[body.id] = trimmed;
    else delete config.keyNames[body.id];
    const storage = await persist();
    if (!storage) return Response.json({ error: "Failed to persist change" }, { status: 503 });
    return Response.json({ ok: true, name: trimmed || body.id, storage });
  }

  if (!env.CONFIG) {
    return Response.json({ error: "User management requires KV storage. Enable CONFIG binding in wrangler.toml." }, { status: 400 });
  }

  if (body.action === "create") {
    if (!body.id) return Response.json({ error: "Missing user ID" }, { status: 400 });
    if (RESERVED_IDS.has(body.id) || config.users.some((u) => u.id === body.id)) {
      return Response.json({ error: "User already exists" }, { status: 400 });
    }
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    const key = btoa(String.fromCharCode(...keyBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const keyHash = await hashKey(key);
    config.users.push({
      id: body.id,
      keyHash,
      keyPreview: "..." + key.slice(-4),
      created: new Date().toISOString().slice(0, 10),
      role: "client",
    });
    const storage = await persist();
    if (!storage) return Response.json({ error: "Failed to persist user" }, { status: 503 });
    return Response.json({ ok: true, id: body.id, key, storage });
  }

  if (body.action === "delete") {
    config.users = config.users.filter((u) => u.id !== body.id);
    const storage = await persist();
    if (!storage) return Response.json({ error: "Failed to persist change" }, { status: 503 });
    return Response.json({ ok: true, storage });
  }

  if (body.action === "update") {
    const user = config.users.find((u) => u.id === body.id);
    if (!user) return Response.json({ error: "User not found" }, { status: 404 });
    if (body.role && ["admin", "client"].includes(body.role)) user.role = body.role;
    if (typeof body.name === "string") {
      if (!config.keyNames) config.keyNames = {};
      const trimmed = body.name.trim().slice(0, 128);
      if (trimmed && trimmed !== body.id) config.keyNames[body.id] = trimmed;
      else delete config.keyNames[body.id];
    }
    const storage = await persist();
    if (!storage) return Response.json({ error: "Failed to persist change" }, { status: 503 });
    return Response.json({ ok: true, storage });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
