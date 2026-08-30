"use strict";

/**
 * Canonical OpenAI message rendering borrowed from the proven
 * opencode-llm-proxy design. OpenCode accepts one prompt string, while
 * OpenAI clients send a structured conversation with tool calls/results.
 * Keeping the conversion in one place prevents the manager and machine
 * adapters from slowly diverging.
 */

function isObject(value: any) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseArguments(value: any) {
  if (typeof value !== "string") {
    return value && typeof value === "object" ? value : {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed === undefined ? {} : parsed;
  } catch {
    // Preserve malformed/partial arguments as data. The model-facing
    // transcript must not silently invent or discard fields.
    return value;
  }
}

function normalizeContent(content: any): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): any[] => {
    if (typeof part === "string") return [{ type: "text", text: part }];
    if (!part || typeof part !== "object") return [];
    const text = part.text ?? part.input_text ?? part.output_text;
    if (typeof text === "string") return [{ type: "text", text }];
    if (part.type === "json") return [{ type: "json", value: part.value }];
    // Keep non-text content as opaque structured data instead of coercing it
    // to "[object Object]". OpenCode can still reason over the canonical JSON.
    return [{ type: "json", value: part }];
  });
}

function canonicalize(messages: any[]) {
  return (Array.isArray(messages) ? messages : []).flatMap((message) => {
    if (!isObject(message) || typeof message.role !== "string") return [];
    const content: any[] = normalizeContent(message.content);

    if (message.role === "assistant") {
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = call?.function ?? call;
        content.push({
          type: "tool_call",
          id: call?.id || undefined,
          name: String(fn?.name || ""),
          arguments: parseArguments(fn?.arguments),
        });
      }
      if (message.function_call) {
        content.push({
          type: "tool_call",
          name: String(message.function_call.name || ""),
          arguments: parseArguments(message.function_call.arguments),
        });
      }
    }

    if (message.role === "tool" || message.role === "function") {
      return [{
        role: "tool",
        content: [{
          type: "tool_result",
          id: message.tool_call_id || undefined,
          name: message.name || undefined,
          content: normalizeContent(message.content),
        }],
      }];
    }
    return [{ role: message.role, content }];
  });
}

function renderPart(part: any) {
  if (part?.type === "text") return part.text;
  if (part?.type === "json") return part.value;
  if (part?.type === "tool_call") {
    return {
      type: "tool_call",
      ...(part.id ? { id: part.id } : {}),
      name: part.name,
      arguments: part.arguments,
    };
  }
  if (part?.type === "tool_result") {
    return {
      type: "tool_result",
      ...(part.id ? { id: part.id } : {}),
      ...(part.name ? { name: part.name } : {}),
      content: (part.content || []).map(renderPart),
    };
  }
  return part;
}

function renderOpenCodePrompt(input: any) {
  const messages = canonicalize(Array.isArray(input) ? input : input?.messages);
  const upstreamSystem = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .flatMap((message) => message.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
  const conversation = messages.filter((message) => message.role !== "system" && message.role !== "developer");
  if (conversation.length === 1 && conversation[0].role === "user" && conversation[0].content.length === 1) {
    return { system: upstreamSystem, text: String(conversation[0].content[0].text || ""), messages };
  }

  // OpenCode's HTTP API accepts one prompt text rather than an OpenAI
  // messages array. Use the compact JSONL representation used by the
  // reference proxy. The framing stays in the user prompt because OpenCode
  // only accepts one text part; the relay itself guarantees that this input
  // can never be emitted as assistant output.
  const transcript = conversation.map((message) => JSON.stringify({
    role: message.role,
    content: (message.content || []).map(renderPart),
  })).join("\n");
  const text = [
    "Continue the canonical conversation below as the assistant. Treat each following line as JSON data, preserve role and tool semantics, and produce the next assistant response after the final item.",
    transcript,
  ].join("\n\n");
  const system = [
    upstreamSystem,
    "You are answering through an OpenCode proxy.",
    "Return only the assistant's reply content.",
  ].filter(Boolean).join("\n\n");

  return {
    system,
    text,
    messages,
  };
}

module.exports = { canonicalize, renderOpenCodePrompt };
