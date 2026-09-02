"use strict";

/** Keep provider session, cache, response-chain and request IDs separate. */
export type HeaderValue = string | string[] | undefined;

export interface SessionRequest { headers?: Record<string, HeaderValue>; }
export interface SessionBody {
  [key: string]: unknown;
  metadata?: Record<string, unknown>;
}

export type SessionAffinitySource =
  | "body.session_id" | "body.metadata.session_id" | "header.x-session-id"
  | "header.x-session-affinity" | "header.session-id" | "header.session_id"
  | "body.conversation" | "body.conversation_id" | "body.metadata.conversation_id"
  | "header.x-conversation-id" | "header.x-opencode-session-id" | null;

export interface SessionContext {
  /** Stable provider session/conversation ID suitable for OpenCode reuse. */
  affinityKey: string | null;
  /** Key used only by manager routing; may fall back to a cache partition. */
  routingKey: string | null;
  conversationId: string | null;
  responseChainId: string | null;
  cacheKey: string | null;
  requestId: string | null;
  affinitySource: SessionAffinitySource;
}

const HEADER_ALIASES = Object.freeze({
  affinity: ["x-session-id", "x-session-affinity", "session-id", "session_id"],
  conversation: ["x-conversation-id", "x-opencode-session-id"],
  request: ["x-client-request-id", "x-request-id", "request-id"],
});
const SESSION_HEADER_NAMES = Object.freeze([
  ...HEADER_ALIASES.affinity,
  ...HEADER_ALIASES.conversation,
]);

function sessionValue(value: unknown): string | null {
  const source = Array.isArray(value) ? value[0] : value;
  if (typeof source === "object" && source !== null && "id" in source) {
    return sessionValue((source as { id?: unknown }).id);
  }
  if (typeof source !== "string") return null;
  const normalized = source.trim();
  return normalized ? normalized.slice(0, 256) : null;
}

function firstValue(source: Record<string, unknown> | undefined, names: readonly string[]): string | null {
  if (!source) return null;
  for (const name of names) {
    const value = sessionValue(source[name]);
    if (value) return value;
  }
  return null;
}

function bodyValue(body: SessionBody | undefined, ...names: string[]): string | null {
  return firstValue(body, names);
}

function metadataValue(body: SessionBody | undefined, ...names: string[]): string | null {
  return firstValue(body?.metadata, names);
}

/**
 * Parse protocol fields by semantics. Explicit affinity wins, conversation
 * IDs are the next stable fallback. Cache keys can influence manager routing,
 * but are never promoted to an OpenCode conversation/session header.
 */
function requestSessionContext(req: SessionRequest | undefined, body: SessionBody | undefined): SessionContext {
  const headers = req?.headers || {};
  const bodySession = bodyValue(body, "session_id", "sessionId");
  const metadataSession = metadataValue(body, "session_id", "sessionId");
  const headerSession = firstValue(headers, HEADER_ALIASES.affinity);
  const bodyConversation = bodyValue(body, "conversation", "conversation_id", "conversationId");
  const metadataConversation = metadataValue(body, "conversation_id", "conversationId");
  const headerConversation = firstValue(headers, HEADER_ALIASES.conversation);
  const cacheKey = bodyValue(body, "prompt_cache_key", "promptCacheKey", "cachedContent", "cached_content");
  const responseChainId = bodyValue(body, "previous_response_id", "previousResponseId", "previous_interaction_id", "previousInteractionId");
  const requestId = firstValue(headers, HEADER_ALIASES.request)
    || bodyValue(body, "request_id", "requestId", "idempotency_key", "idempotencyKey");

  const candidates: Array<{ value: string | null; source: SessionAffinitySource }> = [
    { value: bodySession, source: "body.session_id" },
    { value: metadataSession, source: "body.metadata.session_id" },
    { value: sessionValue(headers["x-session-id"]), source: "header.x-session-id" },
    { value: sessionValue(headers["x-session-affinity"]), source: "header.x-session-affinity" },
    { value: sessionValue(headers["session-id"]), source: "header.session-id" },
    { value: sessionValue(headers.session_id), source: "header.session_id" },
    { value: bodyValue(body, "conversation"), source: "body.conversation" },
    { value: bodyValue(body, "conversation_id", "conversationId"), source: "body.conversation_id" },
    { value: metadataConversation, source: "body.metadata.conversation_id" },
    { value: sessionValue(headers["x-conversation-id"]), source: "header.x-conversation-id" },
    { value: sessionValue(headers["x-opencode-session-id"]), source: "header.x-opencode-session-id" },
  ];
  const selected = candidates.find((candidate) => candidate.value);
  const affinityKey = selected?.value || null;
  const routingKey = affinityKey || cacheKey || null;

  return {
    affinityKey,
    routingKey,
    conversationId: bodyConversation || metadataConversation || headerConversation || null,
    responseChainId: responseChainId || null,
    cacheKey: cacheKey || null,
    requestId: requestId || null,
    affinitySource: selected?.source || null,
  };
}

function requestSessionKey(req: SessionRequest | undefined, body: SessionBody | undefined): string | null {
  return requestSessionContext(req, body).routingKey;
}

function machineSessionHeaders(contextOrKey: SessionContext | string | null | undefined): Record<string, string> {
  const key = typeof contextOrKey === "object" && contextOrKey !== null
    ? contextOrKey.affinityKey
    : contextOrKey;
  const normalized = sessionValue(key);
  return normalized ? { "x-session-id": normalized } : {};
}

module.exports = {
  HEADER_ALIASES,
  SESSION_HEADER_NAMES,
  machineSessionHeaders,
  requestSessionContext,
  requestSessionKey,
  sessionValue,
};
