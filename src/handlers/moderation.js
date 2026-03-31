import { runModel } from "../ai.js";

export async function handleModerations(request, env, rt) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  }

  if (!rt.moderationModel) {
    return Response.json({ error: { message: "No moderation model configured. Enable a utility model with moderation kind.", type: "invalid_request_error" } }, { status: 400 });
  }
  const modModel = rt.moderationModel;
  const inputs = Array.isArray(body.input) ? body.input : [body.input || ""];

  const allCats = ["sexual","hate","harassment","self-harm","sexual/minors",
    "hate/threatening","violence/graphic","violence","harassment/threatening",
    "self-harm/intent","self-harm/instructions"];
  const codeMap = { S1:"violence", S2:"harassment", S3:"sexual", S4:"sexual/minors",
    S5:"harassment", S9:"violence/graphic", S10:"hate", S11:"self-harm", S12:"sexual" };

  const responses = await Promise.all(inputs.map(async (text) => {
    try {
      return { result: await runModel(env, modModel, { messages: [{ role: "user", content: text }] }) };
    } catch (err) {
      return { error: err.message, status: err.status || 502 };
    }
  }));

  const results = [];
  for (const resp of responses) {
    if (resp.error) {
      return Response.json(
        { error: { message: resp.error, type: "server_error" } },
        { status: resp.status }
      );
    }
    const output = (resp.result.response || "safe").trim().toLowerCase();
    const flagged = output.includes("unsafe");
    const cats = {};
    const scores = {};
    for (const c of allCats) { cats[c] = false; scores[c] = 0; }
    if (flagged) {
      for (const line of output.split("\n")) {
        const cat = codeMap[line.trim().toUpperCase()];
        if (cat) { cats[cat] = true; scores[cat] = 0.95; }
      }
    }
    results.push({ flagged, categories: cats, category_scores: scores });
  }

  return Response.json({ id: "modr-" + crypto.randomUUID(), model: modModel.split("/").pop(), results });
}
