const test = require("node:test");
const assert = require("node:assert/strict");
const { machineSessionHeaders, requestSessionContext, requestSessionKey } = require("../src/shared/session.ts");
const { mergeTokenUsage, normalizeTokenUsage, toOpenAIUsage } = require("../src/shared/usage.ts");

test("session affinity accepts Pi headers and prompt cache keys", () => {
  assert.equal(requestSessionKey({ headers: { "x-session-id": " pi-session " } }, {}), "pi-session");
  assert.equal(requestSessionKey({ headers: {} }, { prompt_cache_key: "cache-key" }), "cache-key");
  assert.equal(requestSessionKey({ headers: { "x-client-request-id": "client-request" } }, {}), null);
  assert.deepEqual(machineSessionHeaders(" pi-session "), { "x-session-id": "pi-session" });
  assert.deepEqual(machineSessionHeaders(""), {});
});

test("session context keeps provider IDs separate and prefers body affinity", () => {
  const context = requestSessionContext({
    headers: {
      "x-session-id": "header-session",
      "x-client-request-id": "request-123",
    },
  }, {
    session_id: "body-session",
    conversation: { id: "conversation-1" },
    previous_response_id: "response-1",
    prompt_cache_key: "cache-1",
  });
  assert.equal(context.affinityKey, "body-session");
  assert.equal(context.routingKey, "body-session");
  assert.equal(context.affinitySource, "body.session_id");
  assert.equal(context.conversationId, "conversation-1");
  assert.equal(context.responseChainId, "response-1");
  assert.equal(context.cacheKey, "cache-1");
  assert.equal(context.requestId, "request-123");
});

test("response-chain and request IDs do not become long-lived affinity", () => {
  const context = requestSessionContext({ headers: { "x-request-id": "req-1" } }, {
    previous_response_id: "resp-1",
  });
  assert.equal(context.affinityKey, null);
  assert.equal(context.routingKey, null);
  assert.equal(context.responseChainId, "resp-1");
  assert.equal(context.requestId, "req-1");
});

test("cache keys remain a routing/session slot without being sent as a conversation header", () => {
  const context = requestSessionContext({}, { prompt_cache_key: "cache-only" });
  assert.equal(context.affinityKey, null);
  assert.equal(context.routingKey, "cache-only");
  assert.deepEqual(machineSessionHeaders(context), {});
});

test("OpenCode cache usage survives incomplete final message snapshots", () => {
  assert.deepEqual(normalizeTokenUsage({
    input: 10,
    output: 2,
    reasoning: 3,
    cache: { read: 8, write: 1 },
  }), {
    inputTokens: 10,
    outputTokens: 2,
    reasoningTokens: 3,
    cacheReadTokens: 8,
    cacheWriteTokens: 1,
    totalTokens: 24,
  });
  assert.deepEqual(
    mergeTokenUsage(
      { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      { inputTokens: 10, outputTokens: 2, cacheReadTokens: 8, totalTokens: 20 },
    ),
    {
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
      totalTokens: 20,
    },
  );
});

test("normalizes OpenAI prompt tokens without double-counting cached input", () => {
  assert.deepEqual(normalizeTokenUsage({
    prompt_tokens: 100,
    completion_tokens: 1,
    total_tokens: 101,
    prompt_tokens_details: { cached_tokens: 80 },
  }), {
    inputTokens: 20,
    outputTokens: 1,
    reasoningTokens: 0,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 101,
  });
  assert.deepEqual(toOpenAIUsage({
    inputTokens: 20,
    outputTokens: 1,
    cacheReadTokens: 80,
    totalTokens: 101,
  }), {
    prompt_tokens: 100,
    completion_tokens: 1,
    total_tokens: 101,
    prompt_tokens_details: { cached_tokens: 80 },
  });
});
