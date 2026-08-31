"use strict";

const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
});

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") return null;
  const inputTokens = count(value.input_tokens ?? value.prompt_tokens ?? value.inputTokens ?? value.input);
  const outputTokens = count(value.output_tokens ?? value.completion_tokens ?? value.outputTokens ?? value.output);
  const promptDetails = value.prompt_tokens_details || value.input_tokens_details || {};
  const completionDetails = value.completion_tokens_details || value.output_tokens_details || {};
  const reasoningTokens = count(value.reasoning_tokens ?? value.reasoningTokens ?? value.reasoning ?? completionDetails.reasoning_tokens ?? completionDetails.reasoningTokens);
  const cacheReadTokens = count(value.cache_read_input_tokens ?? value.cache_read_tokens ?? value.cacheReadTokens ?? value.cache?.read ?? promptDetails.cached_tokens ?? promptDetails.cache_read_tokens);
  const cacheWriteTokens = count(value.cache_creation_input_tokens ?? value.cache_write_tokens ?? value.cacheWriteTokens ?? value.cache?.write);
  const totalTokens = count(value.total_tokens ?? value.totalTokens ?? value.total ?? (inputTokens + outputTokens));
  if (!inputTokens && !outputTokens && !reasoningTokens && !cacheReadTokens && !cacheWriteTokens && !totalTokens) return null;
  return { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

function usageFromMessage(message) {
  return normalizeTokenUsage(message?.info?.tokens || message?.usage);
}

// Convert the bridge's normalized counters to the OpenAI-compatible usage
// shape. Cache and reasoning details are emitted only when present so clients
// that compare the classic three-field usage object keep working unchanged.
function toOpenAIUsage(value) {
  const usage = normalizeTokenUsage(value) || EMPTY_USAGE;
  const result: any = {
    prompt_tokens: usage.inputTokens,
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

module.exports = { EMPTY_USAGE, normalizeTokenUsage, usageFromMessage, toOpenAIUsage };
