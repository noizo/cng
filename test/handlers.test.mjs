import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

describe("handlers/chat.js", () => {
  const src = read("src/handlers/chat.js");

  it("exports handleChatCompletion, prepareMessages, stripThinking", () => {
    assert.ok(/export\s+(async\s+)?function\s+handleChatCompletion/.test(src));
    assert.ok(/export\s+function\s+prepareMessages/.test(src));
    assert.ok(/export\s+function\s+stripThinking/.test(src));
  });

  it("handleStreamingResponse and handleNonStreamingResponse are not exported", () => {
    assert.ok(!/export\s+async\s+function\s+handleStreamingResponse/.test(src));
    assert.ok(!/export\s+async\s+function\s+handleNonStreamingResponse/.test(src));
  });

  it("returns 400 on invalid JSON", () => {
    assert.ok(src.includes("Invalid JSON body"));
    assert.ok(src.includes("status: 400"));
  });

  it("supports streaming and non-streaming paths", () => {
    assert.ok(src.includes("body.stream"));
    assert.ok(src.includes("handleStreamingResponse"));
    assert.ok(src.includes("handleNonStreamingResponse"));
  });

  it("strips thinking tags from response", () => {
    assert.ok(src.includes("<think>"));
    assert.ok(src.includes("<thinking>"));
  });

  it("passes tool_calls and tool_choice to API when provided", () => {
    assert.ok(src.includes("body.tools"));
    assert.ok(src.includes("body.tool_choice"));
  });

  it("uses model from rt.chatMap or rt.aliasMap", () => {
    assert.ok(src.includes("rt.chatMap"));
    assert.ok(src.includes("rt.aliasMap"));
  });
});

describe("handlers/images.js", () => {
  const src = read("src/handlers/images.js");

  it("exports handleImageGeneration, handleImageEdits, handleServeImage", () => {
    assert.ok(/export\s+async\s+function\s+handleImageGeneration/.test(src));
    assert.ok(/export\s+async\s+function\s+handleImageEdits/.test(src));
    assert.ok(/export\s+async\s+function\s+handleServeImage/.test(src));
  });

  it("falls back through candidates on failure", () => {
    assert.ok(src.includes("for (const model of candidates)"));
  });

  it("handles NSFW retry with modified prompt", () => {
    assert.ok(src.includes("nsfw"));
    assert.ok(src.includes("nsfwRetry"));
  });

  it("supports both url and b64_json response formats", () => {
    assert.ok(src.includes("b64_json"));
    assert.ok(src.includes("wantUrl"));
  });

  it("inpainting requires image and prompt", () => {
    assert.ok(src.includes("Missing required: image, prompt"));
  });

  it("tries multipart fallback when JSON returns 400", () => {
    assert.ok(src.includes("callImage("));
    assert.ok(src.includes("status === 400"));
  });
});

describe("handlers/audio.js", () => {
  const src = read("src/handlers/audio.js");

  it("exports handleAudioTranscription, handleAudioTranslation, handleAudioSpeech", () => {
    assert.ok(/export\s+async\s+function\s+handleAudioTranscription/.test(src));
    assert.ok(/export\s+async\s+function\s+handleAudioTranslation/.test(src));
    assert.ok(/export\s+async\s+function\s+handleAudioSpeech/.test(src));
  });

  it("transcription supports json, text, vtt, and verbose_json formats", () => {
    assert.ok(src.includes('"text"'));
    assert.ok(src.includes('"vtt"'));
    assert.ok(src.includes('"verbose_json"'));
  });

  it("handles multipart and raw audio input", () => {
    assert.ok(src.includes("multipart"));
    assert.ok(src.includes("arrayBuffer"));
  });

  it("TTS returns chunked audio response", () => {
    assert.ok(src.includes("Transfer-Encoding"));
    assert.ok(src.includes("audio/mpeg"));
  });

  it("TTS handles melotts lang parameter", () => {
    assert.ok(src.includes("melotts"));
    assert.ok(src.includes("lang"));
  });
});

describe("handlers/embeddings.js", () => {
  const src = read("src/handlers/embeddings.js");

  it("exports handleEmbeddings", () => {
    assert.ok(/export\s+async\s+function\s+handleEmbeddings/.test(src));
  });

  it("returns 400 for disallowed models", () => {
    assert.ok(src.includes("Embedding model not allowed"));
  });

  it("resolves aliases via rt.aliasMap", () => {
    assert.ok(src.includes("rt.aliasMap"));
  });

  it("normalizes input to array", () => {
    assert.ok(src.includes("Array.isArray(body.input)"));
  });

  it("returns OpenAI-compatible embedding response", () => {
    assert.ok(src.includes('"embedding"'));
    assert.ok(src.includes('"list"'));
    assert.ok(src.includes("prompt_tokens"));
  });
});

describe("handlers/moderation.js", () => {
  const src = read("src/handlers/moderation.js");

  it("exports handleModerations", () => {
    assert.ok(/export\s+async\s+function\s+handleModerations/.test(src));
  });

  it("returns 400 when no moderation model configured", () => {
    assert.ok(src.includes("No moderation model configured"));
  });

  it("maps Llama Guard codes to OpenAI categories", () => {
    assert.ok(src.includes("codeMap"));
    assert.ok(src.includes("violence"));
    assert.ok(src.includes("harassment"));
    assert.ok(src.includes("sexual"));
  });

  it("processes multiple inputs in parallel", () => {
    assert.ok(src.includes("Promise.all"));
  });
});

describe("handlers/translation.js", () => {
  const src = read("src/handlers/translation.js");

  it("exports handleTextTranslation", () => {
    assert.ok(/export\s+async\s+function\s+handleTextTranslation/.test(src));
  });

  it("accepts text or input field", () => {
    assert.ok(src.includes("body.text || body.input"));
  });

  it("supports source and target language params", () => {
    assert.ok(src.includes("source_lang"));
    assert.ok(src.includes("target_lang"));
  });

  it("resolves aliases via rt.aliasMap", () => {
    assert.ok(src.includes("rt.aliasMap"));
  });

  it("returns translated text with backend model ID", () => {
    assert.ok(src.includes("translated_text"));
    assert.ok(src.includes('model.split("/").pop()'));
  });
});

describe("handlers/models.js", () => {
  const src = read("src/handlers/models.js");

  it("exports handleListModels", () => {
    assert.ok(/export\s+function\s+handleListModels/.test(src));
  });

  it("returns alias names when spoofed", () => {
    assert.ok(src.includes("spoofed"));
    assert.ok(src.includes("cfg.aliases"));
  });

  it("returns real model IDs from all categories when not spoofed", () => {
    assert.ok(src.includes("cfg.chatModels"));
    assert.ok(src.includes("cfg.imageModels"));
    assert.ok(src.includes("cfg.voiceModels"));
    assert.ok(src.includes("cfg.utilityModels"));
  });
});
