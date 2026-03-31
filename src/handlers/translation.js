import { runModel } from "../ai.js";

export async function handleTextTranslation(request, env, rt) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  }

  const text = body.text || body.input || "";
  if (!text) return Response.json({ error: { message: "Missing 'text' field", type: "invalid_request_error" } }, { status: 400 });

  const sourceLang = body.source_lang || body.source || "en";
  const targetLang = body.target_lang || body.target || "es";
  const reqModel = body.model || "m2m100-1.2b";
  const aliasTarget = rt.aliasMap[reqModel];
  const model = rt.translationMap[reqModel] || rt.translationMap[aliasTarget] || Object.values(rt.translationMap)[0];

  if (!model) {
    return Response.json({ error: { message: `Translation model not available: ${reqModel}`, type: "invalid_request_error" } }, { status: 400 });
  }

  let result;
  try {
    result = await runModel(env, model, { text, source_lang: sourceLang, target_lang: targetLang });
  } catch (err) {
    return Response.json(
      { error: { message: err.message, type: "server_error" } },
      { status: err.status || 502 }
    );
  }

  return Response.json({
    translated_text: result.translated_text || "",
    source_lang: sourceLang,
    target_lang: targetLang,
    model: model.split("/").pop(),
  });
}
