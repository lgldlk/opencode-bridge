"use strict";

import type { JsonObject, TokenUsage } from "./types.ts";

const EMPTY_USAGE: Readonly<TokenUsage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
});

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeTokenUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const source = value as JsonObject;
  const promptDetails = source.prompt_tokens_details && typeof source.prompt_tokens_details === "object"
    ? source.prompt_tokens_details as JsonObject
    : source.input_tokens_details && typeof source.input_tokens_details === "object"
      ? source.input_tokens_details as JsonObject
      : {};
  const completionDetails = source.completion_tokens_details && typeof source.completion_tokens_details === "object"
    ? source.completion_tokens_details as JsonObject
    : source.output_tokens_details && typeof source.output_tokens_details === "object"
      ? source.output_tokens_details as JsonObject
      : {};
  const cache = source.cache && typeof source.cache === "object" ? source.cache as JsonObject : {};
  const normalizedShape = source.inputTokens !== undefined
    || source.outputTokens !== undefined
    || source.cacheReadTokens !== undefined
    || source.cacheWriteTokens !== undefined;
  const openCodeShape = normalizedShape
    || source.input !== undefined
    || source.output !== undefined
    || source.cache !== undefined;
  const rawInputTokens = count(source.input_tokens ?? source.prompt_tokens ?? source.inputTokens ?? source.input);
  const outputTokens = count(source.output_tokens ?? source.completion_tokens ?? source.outputTokens ?? source.output);
  const reasoningTokens = count(source.reasoning_tokens ?? source.reasoningTokens ?? source.reasoning ?? completionDetails.reasoning_tokens ?? completionDetails.reasoningTokens);
  const cacheReadTokens = count(source.cache_read_input_tokens ?? source.cache_read_tokens ?? source.cacheReadTokens ?? cache.read ?? promptDetails.cached_tokens ?? promptDetails.cache_read_tokens);
  const cacheWriteTokens = count(source.cache_creation_input_tokens ?? source.cache_write_tokens ?? source.cacheWriteTokens ?? cache.write);
  // OpenAI's prompt_tokens includes cached prompt tokens. Internally we keep
  // inputTokens as the uncached portion so totals and cache-rate reporting do
  // not double count the same tokens. OpenCode's `input` is already uncached.
  const inputTokens = openCodeShape
    ? rawInputTokens
    : Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens);
  const inferredTotal = openCodeShape
    ? inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens
    : rawInputTokens + outputTokens + reasoningTokens;
  const totalTokens = count(source.total_tokens ?? source.totalTokens ?? source.total ?? inferredTotal);
  if (!inputTokens && !outputTokens && !reasoningTokens && !cacheReadTokens && !cacheWriteTokens && !totalTokens) return null;
  return { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

function usageFromMessage(message: unknown): TokenUsage | null {
  if (!message || typeof message !== "object") return null;
  const source = message as JsonObject;
  const info = source.info && typeof source.info === "object" ? source.info as JsonObject : undefined;
  return normalizeTokenUsage(info?.tokens || source.usage);
}

function mergeTokenUsage(primary: unknown, secondary: unknown): TokenUsage | null {
  const first = normalizeTokenUsage(primary);
  const second = normalizeTokenUsage(secondary);
  if (!first) return second;
  if (!second) return first;
  const merged = {
    inputTokens: Math.max(first.inputTokens, second.inputTokens),
    outputTokens: Math.max(first.outputTokens, second.outputTokens),
    reasoningTokens: Math.max(first.reasoningTokens, second.reasoningTokens),
    cacheReadTokens: Math.max(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: Math.max(first.cacheWriteTokens, second.cacheWriteTokens),
    totalTokens: Math.max(first.totalTokens, second.totalTokens),
  };
  merged.totalTokens = Math.max(
    merged.totalTokens,
    merged.inputTokens + merged.outputTokens + merged.reasoningTokens
      + merged.cacheReadTokens + merged.cacheWriteTokens,
  );
  return merged;
}

// Convert the bridge's normalized counters to the OpenAI-compatible usage
// shape. Cache and reasoning details are emitted only when present so clients
// that compare the classic three-field usage object keep working unchanged.
function toOpenAIUsage(value: unknown): Record<string, unknown> {
  const usage = normalizeTokenUsage(value) || EMPTY_USAGE;
  const result: Record<string, unknown> = {
    // OpenAI prompt_tokens is the complete prompt, including cache reads and
    // cache writes. Clients subtract the detail fields to recover uncached
    // input; emitting only inputTokens makes cache usage appear artificially
    // low (or even negative after client-side normalization).
    prompt_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
  if (usage.cacheReadTokens > 0) {
    result.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens };
  }
  if (usage.reasoningTokens > 0) {
    result.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  }
  // OpenAI-compatible clients generally ignore unknown usage keys. Retain the
  // Anthropic/OpenCode spelling for providers that report cache creation.
  if (usage.cacheWriteTokens > 0) {
    result.cache_creation_input_tokens = usage.cacheWriteTokens;
  }
  return result;
}

module.exports = { EMPTY_USAGE, mergeTokenUsage, normalizeTokenUsage, usageFromMessage, toOpenAIUsage };
