import { loadConfig } from "./config.js";

export async function hashKey(key) {
  const data = new TextEncoder().encode(key);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function identifyKey(request, env, config) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const enc = new TextEncoder();
  const a = enc.encode(token);

  const adminKey = env.API_KEY || "";
  if (adminKey) {
    const b = enc.encode(adminKey);
    if (a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b)) {
      return { id: "admin", role: "admin" };
    }
  }
  const key2 = env.API_KEY_2 || "";
  if (key2) {
    const b2 = enc.encode(key2);
    if (a.byteLength === b2.byteLength && crypto.subtle.timingSafeEqual(a, b2)) {
      return { id: "key2", role: "client" };
    }
  }

  const cfg = config || await loadConfig(env);
  if (cfg.users) {
    const tokenHash = await hashKey(token);
    const enc2 = new TextEncoder();
    for (const user of cfg.users) {
      const a2 = enc2.encode(tokenHash);
      const b2 = enc2.encode(user.keyHash || "");
      if (a2.length === b2.length && crypto.subtle.timingSafeEqual(a2, b2)) {
        return { id: user.id, role: user.role || "client" };
      }
    }
  }
  return null;
}

export function isAdmin(auth) {
  return auth?.role === "admin";
}
