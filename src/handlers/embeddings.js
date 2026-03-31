import { runModel } from "../ai.js";

export async function handleEmbeddings(request, env, rt) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 }
    );
  }
  const reqModel = body.model || "bge-m3";
  const aliasTarget = rt.aliasMap[reqModel];
  const model = rt.embeddingMap[reqModel] || rt.embeddingMap[aliasTarget];

  if (!model) {
    return Response.json(
      { error: { message: `Embedding model not allowed: ${reqModel}`, type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  const input = Array.isArray(body.input) ? body.input : [body.input || ""];

  let result;
  try {
    result = await runModel(env, model, { text: input });
  } catch (err) {
    return Response.json(
      { error: { message: err.message, type: "api_error" } },
      { status: err.status || 502 }
    );
  }

  const vectors = result.data || result.response || result;
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
