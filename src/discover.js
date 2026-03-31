export const TASK_MAP = {
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

export const TASK_KIND = {
  "Automatic Speech Recognition": "stt",
  "Text-to-Speech": "tts",
  "Text Embeddings": "embedding",
  "Translation": "translation",
  "Text Classification": "moderation",
  "Summarization": "summarization",
  "Object Detection": "detection",
  "Image Classification": "classification",
};

export async function handleDiscover(env, cfg) {
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
      contextWindow: props.context_window ? (parseInt(props.context_window, 10) || null) : null,
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
