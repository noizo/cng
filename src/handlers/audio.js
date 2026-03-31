import { runModelRaw, runModelBinary } from "../ai.js";

export async function handleAudioTranscription(request, env, rt) {
  const ct = request.headers.get("content-type") || "";
  let audioData, requestedModel = "whisper-large-v3-turbo", responseFormat = "json";

  if (ct.includes("multipart")) {
    const form = await request.formData().catch(() => null);
    if (!form) return Response.json({ error: { message: "Invalid form data", type: "invalid_request_error" } }, { status: 400 });
    const file = form.get("file");
    if (!file) return Response.json({ error: { message: "Missing 'file' field", type: "invalid_request_error" } }, { status: 400 });
    audioData = await file.arrayBuffer();
    requestedModel = form.get("model") || requestedModel;
    responseFormat = form.get("response_format") || responseFormat;
  } else {
    audioData = await request.arrayBuffer();
  }

  const model = rt.sttMap[requestedModel] || rt.aliasMap[requestedModel] || Object.values(rt.sttMap)[0] || "@cf/openai/whisper-large-v3-turbo";

  let result;
  try {
    result = await runModelRaw(env, model, audioData);
  } catch (err) {
    return Response.json(
      { error: { message: err.message || "Transcription failed", type: "server_error" } },
      { status: err.status || 502 }
    );
  }

  const text = result.text || "";
  if (responseFormat === "text") return new Response(text, { headers: { "Content-Type": "text/plain" } });
  if (responseFormat === "vtt") return new Response(result.vtt || text, { headers: { "Content-Type": "text/vtt" } });
  if (responseFormat === "verbose_json") {
    return Response.json({
      task: "transcribe", language: result.language || "en",
      duration: result.duration || 0, text,
      words: result.words || [], segments: result.segments || [],
    });
  }
  return Response.json({ text });
}

export async function handleAudioTranslation(request, env, rt) {
  const ct = request.headers.get("content-type") || "";
  let audioData, responseFormat = "json";

  if (ct.includes("multipart")) {
    const form = await request.formData().catch(() => null);
    if (!form) return Response.json({ error: { message: "Invalid form data", type: "invalid_request_error" } }, { status: 400 });
    const file = form.get("file");
    if (!file) return Response.json({ error: { message: "Missing 'file' field", type: "invalid_request_error" } }, { status: 400 });
    audioData = await file.arrayBuffer();
    responseFormat = form.get("response_format") || responseFormat;
  } else {
    audioData = await request.arrayBuffer();
  }

  const sttModel = Object.values(rt.sttMap)[0] || "@cf/openai/whisper-large-v3-turbo";

  let result;
  try {
    result = await runModelRaw(env, sttModel, audioData);
  } catch (err) {
    return Response.json(
      { error: { message: err.message || "Translation failed", type: "server_error" } },
      { status: err.status || 502 }
    );
  }

  const text = result.text || "";
  if (responseFormat === "text") return new Response(text, { headers: { "Content-Type": "text/plain" } });
  if (responseFormat === "verbose_json") {
    return Response.json({
      task: "translate", language: result.language || "en",
      duration: result.duration || 0, text,
    });
  }
  return Response.json({ text });
}

export async function handleAudioSpeech(request, env, rt) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  }

  const input = body.input || "";
  if (!input) return Response.json({ error: { message: "Missing 'input' field", type: "invalid_request_error" } }, { status: 400 });

  const reqModel = body.model || "tts-1";
  const model = rt.ttsMap[reqModel] || rt.aliasMap[reqModel] || Object.values(rt.ttsMap)[0] || "@cf/deepgram/aura-2-en";
  const audioFmt = body.response_format || "mp3";
  const payload = model.includes("melotts") ? { text: input, lang: "EN" } : { text: input };

  let audioStream;
  try {
    audioStream = await runModelBinary(env, model, payload);
  } catch (err) {
    return Response.json(
      { error: { message: err.message || "TTS failed", type: "server_error" } },
      { status: err.status || 502 }
    );
  }

  const ctMap = { mp3: "audio/mpeg", opus: "audio/opus", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav", pcm: "audio/pcm" };
  return new Response(audioStream, {
    headers: { "Content-Type": ctMap[audioFmt] || "audio/mpeg", "Transfer-Encoding": "chunked" },
  });
}
