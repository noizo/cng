import { identifyKey, isAdmin } from "./auth.js";
import { loadConfig, getRuntimeMaps, handleGetConfig, handleSaveConfig } from "./config.js";
import { fetchStatusData } from "./status.js";
import { handleGetUsers, handleUserAction } from "./users.js";
import { handleDiscover } from "./discover.js";
import { checkRate, inferenceCategory, recordModel, getModelHealth } from "./ratelimit.js";
import { handleChatCompletion } from "./handlers/chat.js";
import { handleImageGeneration, handleImageEdits, handleServeImage } from "./handlers/images.js";
import { handleAudioTranscription, handleAudioTranslation, handleAudioSpeech } from "./handlers/audio.js";
import { handleEmbeddings } from "./handlers/embeddings.js";
import { handleListModels } from "./handlers/models.js";
import { handleModerations } from "./handlers/moderation.js";
import { handleTextTranslation } from "./handlers/translation.js";
import UI_HTML from "./ui.html";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function withCors(response) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isGet = request.method === "GET";
    const isPost = request.method === "POST";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (isGet && url.pathname === "/config") {
      return new Response(UI_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https://img.shields.io; frame-ancestors 'none'",
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    if (isGet && url.pathname.startsWith("/img/")) {
      return handleServeImage(url);
    }

    if (!isGet && !isPost) {
      return withCors(new Response("Method not allowed", { status: 405 }));
    }

    const cfg = await loadConfig(env);
    const auth = await identifyKey(request, env, cfg);
    if (!auth) {
      return withCors(new Response("Unauthorized", { status: 401 }));
    }

    const category = inferenceCategory(url.pathname);
    if (category) {
      const rate = checkRate(auth, cfg, category);
      if (!rate.allowed) {
        const retryAfter = Math.ceil((rate.reset - Date.now()) / 1000);
        return withCors(new Response(
          JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(retryAfter),
              "X-RateLimit-Limit": String(rate.limit),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(Math.ceil(rate.reset / 1000)),
            },
          }
        ));
      }
      if (isPost) {
        try {
          const peek = await request.clone().json();
          if (typeof peek.model === "string") recordModel(auth.id, peek.model);
        } catch {}
      }
    }

    const spoofed = (cfg.spoofedKeys || []).includes(auth.id);
    const rt = getRuntimeMaps(cfg);
    const route = async () => {
      if (isGet && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        return handleListModels(cfg, spoofed);
      }

      if (isGet && url.pathname === "/api/status") {
        if (!isAdmin(auth)) return Response.json({ error: "Forbidden" }, { status: 403 });
        const status = await fetchStatusData(env);
        status.modelHealth = await getModelHealth(env);
        return Response.json(status);
      }

      if (isGet && url.pathname === "/api/config") {
        if (!isAdmin(auth)) return Response.json({ error: "Forbidden" }, { status: 403 });
        return handleGetConfig(env);
      }
      if (isPost && url.pathname === "/api/config") {
        if (!isAdmin(auth)) return Response.json({ error: "Forbidden" }, { status: 403 });
        return handleSaveConfig(request, env);
      }
      if (isGet && url.pathname === "/api/discover") {
        if (!isAdmin(auth)) return Response.json({ error: "Forbidden" }, { status: 403 });
        return handleDiscover(env, cfg);
      }
      if (isGet && url.pathname === "/api/users") {
        if (!isAdmin(auth)) return Response.json({ error: "Forbidden" }, { status: 403 });
        return handleGetUsers(env);
      }
      if (isPost && url.pathname === "/api/users") {
        if (!isAdmin(auth)) return Response.json({ error: "Forbidden" }, { status: 403 });
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
        { error: { message: "Unknown endpoint: " + url.pathname, type: "invalid_request_error" } },
        { status: 404 }
      );
    };

    return withCors(await route());
  },
};
