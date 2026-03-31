import { runImageJson, runImageMultipart } from "../ai.js";
import { reportModelError, reportModelOk } from "../ratelimit.js";

export async function handleServeImage(url) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (!cached) {
    return new Response("Not found", { status: 404 });
  }
  return cached;
}

function bytesToBase64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(""));
}

function extractB64(result) {
  if (!result) return { b64: null, error: "No result from AI", status: 502 };
  if (result.imageBytes) {
    return result.imageBytes.length > 0
      ? { b64: bytesToBase64(result.imageBytes) }
      : { b64: null, error: "Empty image data", status: 502 };
  }
  if (result.image) return { b64: result.image };
  return { b64: null, error: "Unrecognised image response format", status: 502 };
}

async function callImage(env, model, prompt, width, height, useMultipart) {
  try {
    let result;
    if (useMultipart) {
      const form = new FormData();
      form.append("prompt", prompt);
      form.append("width", String(width));
      form.append("height", String(height));
      result = await runImageMultipart(env, model, new Response(form));
    } else {
      result = await runImageJson(env, model, { prompt, width, height });
    }
    const ext = extractB64(result);
    if (ext.b64 && ext.b64 !== "nsfw") reportModelOk(model, env);
    else if (!ext.b64) reportModelError(model, env);
    return ext;
  } catch (err) {
    reportModelError(model, env);
    const errStr = (err.message || "").toLowerCase();
    if (errStr.includes("nsfw")) return { b64: "nsfw" };
    return { b64: null, error: "Image generation failed", status: err.status || 502 };
  }
}

export async function handleImageGeneration(request, env, rt, spoofed) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 }
    );
  }
  if (!rt.imageList.length) {
    return Response.json(
      { error: { message: "No image models configured", type: "invalid_request_error" } },
      { status: 400 }
    );
  }
  const prompt = body.prompt || "";
  const requestedModel = body.model || "";
  const aliasTarget = rt.aliasMap[requestedModel];
  const primaryModel = rt.imageMap[requestedModel] || rt.imageMap[aliasTarget] || aliasTarget || rt.imageList[0];
  const candidates = [primaryModel, ...rt.imageList.filter(p => p !== primaryModel)];
  const defaultFmt = spoofed ? "url" : "b64_json";
  const wantUrl = (body.response_format || defaultFmt) === "url";
  const isHd = (body.quality || "").toLowerCase() === "hd";
  const rawSize = body.size || null;
  const isDefaultSquare = rawSize === "1024x1024";
  const size = isDefaultSquare ? null : rawSize;

  let lastError = "Image generation failed";
  let lastStatus = 500;
  const debugLog = [];

  for (const model of candidates) {
    const dim = rt.maxDimMap[model] || 1920;
    let width, height;
    if (size) {
      const [sw, sh] = size.split("x").map(Number);
      width = Math.min(sw || 1024, dim);
      height = Math.min(sh || 1024, dim);
    } else if (isHd) {
      width = Math.min(1024, dim);
      height = Math.min(1792, dim);
    } else {
      width = dim;
      height = Math.round(dim * 0.75);
    }

    for (let nsfwRetry = 0; nsfwRetry < 2; nsfwRetry++) {
      const effectivePrompt = nsfwRetry === 0
        ? prompt
        : `Product photography, professional studio: ${prompt}`;

      let imgExtract = await callImage(env, model, effectivePrompt, width, height, rt.multipartSet.has(model));

      if (!rt.multipartSet.has(model) && imgExtract.status === 400) {
        imgExtract = await callImage(env, model, effectivePrompt, width, height, true);
      }

      const b64 = imgExtract.b64;
      if (b64 === "nsfw") continue;

      if (!b64) {
        lastError = "Image generation failed";
        lastStatus = imgExtract.status || 500;
        debugLog.push(`${model.split("/").pop()}:${lastStatus}`);
        break;
      }

      const backendModel = model.split("/").pop();
      const revisedPrompt = `[${backendModel}] ${effectivePrompt}`;
      const responseModel = (spoofed && requestedModel) ? requestedModel : backendModel;

      if (wantUrl) {
        const imgId = crypto.randomUUID();
        const imgUrl = new URL(`/img/${imgId}`, request.url).toString();
        let imgBytes;
        try {
          imgBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        } catch {
          lastError = "Invalid image data";
          lastStatus = 400;
          debugLog.push(`${model.split("/").pop()}:${lastStatus}:${lastError}`);
          break;
        }
        const imgResp = new Response(imgBytes, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=3600",
          },
        });
        await caches.default.put(new Request(imgUrl), imgResp);

        return Response.json({
          created: Math.floor(Date.now() / 1000),
          model: responseModel,
          data: [{ url: imgUrl, revised_prompt: revisedPrompt }],
          _debug: debugLog.length ? debugLog : undefined,
        });
      }

      return Response.json({
        created: Math.floor(Date.now() / 1000),
        model: responseModel,
        data: [{ b64_json: b64, revised_prompt: revisedPrompt }],
        _debug: debugLog.length ? debugLog : undefined,
      });
    }
  }

  return Response.json(
    { error: { message: lastError, type: "server_error" } },
    { status: lastStatus }
  );
}

export async function handleImageEdits(request, env, rt, spoofed) {
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

  let result;
  try {
    result = await runImageMultipart(env, rt.inpaintingModel, fwdResp);
  } catch (err) {
    reportModelError(rt.inpaintingModel, env);
    return Response.json(
      { error: { message: "Image edit failed", type: "server_error" } },
      { status: err.status || 502 }
    );
  }

  const imgResult = extractB64(result);
  if (!imgResult.b64) {
    reportModelError(rt.inpaintingModel, env);
    return Response.json(
      { error: { message: "Image edit failed", type: "server_error" } },
      { status: imgResult.status || 502 }
    );
  }
  reportModelOk(rt.inpaintingModel, env);

  const b64 = imgResult.b64;
  if (wantUrl) {
    const imgId = crypto.randomUUID();
    const imgUrl = new URL("/img/" + imgId, request.url).toString();
    let imgBytes;
    try {
      imgBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    } catch {
      return Response.json(
        { error: { message: "Invalid image data", type: "invalid_request_error" } },
        { status: 400 }
      );
    }
    await caches.default.put(new Request(imgUrl), new Response(
      imgBytes,
      { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } }
    ));
    return Response.json({ created: Math.floor(Date.now() / 1000), data: [{ url: imgUrl, revised_prompt: prompt }] });
  }
  return Response.json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64, revised_prompt: prompt }] });
}
