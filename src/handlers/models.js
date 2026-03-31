export function handleListModels(cfg, spoofed) {
  const data = [];

  if (spoofed) {
    for (const a of cfg.aliases || []) {
      data.push({ id: a.name, object: "model", owned_by: "openai" });
    }
  } else {
    const ownerFromPath = (p) => { const parts = p.split("/"); return parts.length >= 3 ? parts[2] : "system"; };
    for (const m of cfg.chatModels || []) {
      data.push({ id: m.id, object: "model", owned_by: ownerFromPath(m.path) });
    }
    for (const m of cfg.imageModels || []) {
      data.push({ id: m.id, object: "model", owned_by: ownerFromPath(m.path) });
    }
    for (const m of cfg.voiceModels || []) {
      data.push({ id: m.id, object: "model", owned_by: ownerFromPath(m.path) });
    }
    for (const m of cfg.utilityModels || []) {
      data.push({ id: m.id, object: "model", owned_by: ownerFromPath(m.path) });
    }
  }

  return Response.json({ object: "list", data });
}
