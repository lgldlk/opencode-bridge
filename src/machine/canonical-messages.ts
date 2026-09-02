"use strict";

import type {
  CanonicalMessage,
  CanonicalPart,
  JsonObject,
  JsonValue,
  OpenAIMessage,
} from "../shared/types.ts";

/**
 * Canonical OpenAI message rendering borrowed from the proven
 * opencode-llm-proxy design. OpenCode accepts one prompt string, while
 * OpenAI clients send a structured conversation with tool calls/results.
 * Keeping the conversion in one place prevents the manager and machine
 * adapters from slowly diverging.
 */

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseArguments(value: unknown): string | JsonObject {
  // Keep the caller's original JSON text. Parsing and re-stringifying tool
  // arguments changes whitespace and can change the observable payload even
  // when the object is semantically equivalent.
  if (typeof value === "string") return value;
  return isObject(value) ? value : {};
}

function normalizeContent(content: unknown): CanonicalPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content === null || content === undefined) return [];
  if (!Array.isArray(content)) return [{ type: "json", value: content as JsonValue }];
  return content.flatMap((part): CanonicalPart[] => {
    if (typeof part === "string") return [{ type: "text", text: part }];
    if (!part || typeof part !== "object") return [{ type: "json", value: part }];
    const source = part as Record<string, unknown>;
    const text = source.text ?? source.input_text ?? source.output_text;
    if (typeof text === "string") return [{ type: "text", text }];
    if (source.type === "json") return [{ type: "json", value: source.value as JsonValue }];
    // Keep non-text content as opaque structured data instead of coercing it
    // to "[object Object]". OpenCode can still reason over the canonical JSON.
    return [{ type: "json", value: part as JsonValue }];
  });
}

function canonicalize(messages: unknown): CanonicalMessage[] {
  return (Array.isArray(messages) ? messages : []).flatMap((message) => {
    if (!isObject(message) || typeof message.role !== "string") return [];
    const source = message as OpenAIMessage;
    const content = normalizeContent(source.content);

    if (source.role === "assistant") {
      for (const call of Array.isArray(source.tool_calls) ? source.tool_calls : []) {
        const fn = call.function ?? call;
        content.push({
          type: "tool_call",
          id: call.id || undefined,
          name: String(fn.name || ""),
          arguments: parseArguments(fn.arguments),
        });
      }
      if (source.function_call) {
        content.push({
          type: "tool_call",
          name: String(source.function_call.name || ""),
          arguments: parseArguments(source.function_call.arguments),
        });
      }
    }

    if (source.role === "tool" || source.role === "function") {
      return [{
        ...source,
        role: "tool",
        content: [{
          type: "tool_result",
          id: source.tool_call_id || undefined,
          name: source.name || undefined,
          content: normalizeContent(source.content),
        }],
      }];
    }
    // Retain all caller-supplied message metadata. Only `content` is
    // normalized because OpenCode's prompt endpoint accepts text rather than
    // an OpenAI message array; unknown fields must not disappear at the
    // protocol boundary.
    return [{ ...source, role: source.role, content }];
  });
}

function renderPart(part: CanonicalPart): JsonValue {
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
  return part as unknown as JsonValue;
}

function renderOpenCodePrompt(input: unknown) {
  const source = isObject(input) ? input : {};
  const messages = canonicalize(Array.isArray(input) ? input : source.messages);
  const upstreamSystem = messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .flatMap((message) => message.content || [])
    .map((part) => {
      const rendered = renderPart(part);
      return typeof rendered === "string" ? rendered : JSON.stringify(rendered);
    })
    .join("\n\n")
    .trim();
  const conversation = messages.filter((message) => message.role !== "system" && message.role !== "developer");
  if (conversation.length === 1 && conversation[0].role === "user" && conversation[0].content.length === 1) {
    const firstPart = conversation[0].content[0];
    return { system: upstreamSystem, text: firstPart.type === "text" ? firstPart.text : String(renderPart(firstPart) ?? ""), messages };
  }

  // OpenCode's HTTP API accepts one prompt text rather than an OpenAI
  // messages array. Use the compact JSONL representation used by the
  // reference proxy. The framing stays in the user prompt because OpenCode
  // only accepts one text part; the relay itself guarantees that this input
  // can never be emitted as assistant output.
  const transcript = conversation.map((message) => {
    // Tool calls are already represented once in canonical `content` as
    // `tool_call` parts. Keeping the original OpenAI fields alongside them
    // would duplicate every call in the model-facing transcript.
    const { tool_calls: _toolCalls, function_call: _functionCall, ...rest } = message;
    return JSON.stringify({
      ...rest,
      content: (message.content || []).map(renderPart),
    });
  }).join("\n");
  const text = transcript;
  const system = upstreamSystem;

  return {
    system,
    text,
    messages,
  };
}

module.exports = { canonicalize, renderOpenCodePrompt };
