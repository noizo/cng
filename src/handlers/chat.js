import { runModel, runModelStream } from "../ai.js";
import { reportModelError, reportModelOk } from "../ratelimit.js";

export function stripThinking(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trimStart();
}

export function prepareMessages(body, rt) {
  const requestedModel = body.model || "";
  const chatAlias = rt.aliasMap[requestedModel];
  const model = rt.chatMap[requestedModel] || rt.chatMap[chatAlias] || chatAlias
    || rt.chatMap[requestedModel.split("/").pop()];

  if (!model) {
    return { error: `Model not allowed: ${body.model}` };
  }

  const isAlias = !!rt.aliasMap[requestedModel];
  const isVision = rt.visionSet.has(model);
  const MAX_CONTEXT = rt.contextMap[model] || 32768;
  const rawMax = body.max_tokens || 2048;
  const maxTokens = Math.min(Math.max(rawMax, 256), Math.min(MAX_CONTEXT / 4, 16384));
  const inputBudget = MAX_CONTEXT - maxTokens;

  const normalized = (body.messages || []).map((msg) => {
    if (!Array.isArray(msg.content)) {
      return { role: msg.role, content: String(msg.content ?? "") };
    }
    if (isVision) {
      return { role: msg.role, content: msg.content };
    }
    return {
      role: msg.role,
      content: msg.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n"),
    };
  });

  const contentLen = (c) => typeof c === "string" ? c.length : JSON.stringify(c).length;
  const estimateTokens = (c) => Math.ceil(contentLen(c) / 3.5);

  const system = normalized.filter((m) => m.role === "system");
  const rest = normalized.filter((m) => m.role !== "system");

  if (isAlias && model.includes("qwen")) {
    const noThinkMsg = { role: "system", content: "/no_think" };
    system.push(noThinkMsg);
  }

  let used = system.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const messages = [...system];

  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokens(rest[i].content);
    if (used + cost > inputBudget) break;
    messages.splice(system.length, 0, rest[i]);
    used += cost;
  }

  return { model, messages, maxTokens, requestedModel };
}

export async function handleChatCompletion(request, env, rt, _spoofed) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 }
    );
  }
  const prepared = prepareMessages(body, rt);

  if (prepared.error) {
    return Response.json(
      { error: { message: prepared.error, type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  const { model, messages, maxTokens, requestedModel } = prepared;
  const wantStream = Boolean(body.stream);

  const inputs = {
    messages,
    max_tokens: maxTokens,
    temperature: body.temperature ?? 0.6,
    ...(body.top_p != null && { top_p: body.top_p }),
    ...(body.frequency_penalty != null && { frequency_penalty: body.frequency_penalty }),
    ...(body.presence_penalty != null && { presence_penalty: body.presence_penalty }),
    ...(body.repetition_penalty != null && { repetition_penalty: body.repetition_penalty }),
    ...(body.seed != null && { seed: body.seed }),
    ...(body.tools && { tools: body.tools }),
    ...(body.tool_choice && { tool_choice: body.tool_choice }),
  };

  if (wantStream) {
    return handleStreamingResponse(env, model, inputs, requestedModel);
  }
  return handleNonStreamingResponse(env, model, inputs, requestedModel);
}

async function handleStreamingResponse(env, model, inputs, requestedModel) {
  let stream;
  try {
    stream = await runModelStream(env, model, inputs);
  } catch (err) {
    reportModelError(model, env);
    return Response.json(
      { error: { message: "Stream request failed", type: "api_error" } },
      { status: err.status || 502 }
    );
  }

  if (!stream) {
    return Response.json(
      { error: { message: "Workers AI returned no stream", type: "api_error" } },
      { status: 502 }
    );
  }

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const writeChunk = async (data) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  (async () => {
    try {
      const reader = stream.getReader();
      let buffer = "";
      let sentRole = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;

          let parsed;
          try { parsed = JSON.parse(payload); } catch { continue; }

          const r = parsed.result ?? parsed;
          const choice = r.choices?.[0];

          if (r.response != null) {
            const delta = sentRole
              ? { content: r.response }
              : { role: "assistant", content: r.response };
            sentRole = true;
            await writeChunk({
              id, object: "chat.completion.chunk", created, model: requestedModel,
              choices: [{ index: 0, delta, finish_reason: null }],
            });
            continue;
          }

          if (choice?.delta) {
            const delta = {};
            if (!sentRole) delta.role = "assistant";
            if (choice.delta.content != null) delta.content = choice.delta.content;
            if (choice.delta.reasoning_content != null) delta.reasoning_content = choice.delta.reasoning_content;
            if (choice.delta.tool_calls) delta.tool_calls = choice.delta.tool_calls;

            if (!sentRole || delta.content || delta.reasoning_content || delta.tool_calls) {
              sentRole = true;
              await writeChunk({
                id, object: "chat.completion.chunk", created, model: requestedModel,
                choices: [{ index: 0, delta, finish_reason: null }],
              });
            }

            if (choice.finish_reason) {
              await writeChunk({
                id, object: "chat.completion.chunk", created, model: requestedModel,
                choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
                ...(r.usage && { usage: r.usage }),
              });
            }
          }
        }
      }
      reportModelOk(model, env);
    } catch (_err) {
      reportModelError(model, env);
      await writer.write(
        encoder.encode(`data: ${JSON.stringify({ error: { message: "Stream interrupted", type: "stream_error" } })}\n\n`)
      ).catch(() => {});
    } finally {
      await writer.write(encoder.encode("data: [DONE]\n\n")).catch(() => {});
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function handleNonStreamingResponse(env, model, inputs, requestedModel) {
  let r;
  try {
    r = await runModel(env, model, inputs);
    reportModelOk(model, env);
  } catch (err) {
    reportModelError(model, env);
    return Response.json(
      { error: { message: "Model request failed", type: "api_error" } },
      { status: err.status || 502 }
    );
  }

  const msg = r.choices?.[0]?.message;
  const rawContent = r.response
    || (msg?.content != null ? msg.content : null)
    || "";
  const content = stripThinking(rawContent);

  const reasoning = msg?.reasoning_content || null;

  const usage = r.usage || r.choices?.[0]?.usage || {};

  return Response.json({
    id: r.id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(reasoning && { reasoning_content: reasoning }),
          ...(msg?.tool_calls && { tool_calls: msg.tool_calls }),
        },
        finish_reason: r.choices?.[0]?.finish_reason || "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
  });
}
