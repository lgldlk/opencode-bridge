"use strict";

export type RoutingStrategy = "round_robin" | "random" | "quota_failover";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject { [key: string]: unknown; }
export type JsonArray = JsonValue[];

export interface RoutingConfig {
  strategy: RoutingStrategy;
  rateLimitCooldownMs: number;
}

export interface MachineConfig {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  weight?: number;
  cooldownUntil?: string | null;
  [key: string]: unknown;
}

export interface ManagerConfig {
  configPath: string;
  usageDbPath?: string;
  host: string;
  port: number;
  adminKey: string;
  clientKey: string;
  requestTimeoutMs: number;
  upstreamConnectTimeoutMs: number;
  firstDataTimeoutMs: number;
  idleDataTimeoutMs: number;
  healthIntervalMs: number;
  sessionAffinityTtlMs: number;
  sessionAffinityMaxEntries: number;
  routingStrategy?: RoutingStrategy;
  rateLimitCooldownMs?: number | string;
  webDir: string;
}

export interface MachineRuntime {
  status: "unknown" | "healthy" | "unhealthy";
  failures: number;
  models: string[];
  checkedAt: string | null;
  lastError: string | null;
  latencyMs: number | null;
  usage: UsageSummary;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface MachinePublicView extends Omit<MachineConfig, "apiKey">, MachineRuntime {
  name: string;
  enabled: boolean;
  weight: number;
  cooldownUntil: string | null;
  cooldownRemainingMs: number;
  routingEligible: boolean;
}

export interface UsageSummary extends TokenUsage {
  requests?: number;
  lastRequestAt?: string | null;
  byModel?: Record<string, UsageSummary>;
  daily?: Array<UsageSummary & { day: string }>;
}

export interface UsageRequest {
  id: string;
  machineId: string;
  model: string | null;
  stream: boolean;
  status: string;
  requestedAt: string;
  completedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface UsageRequestPage {
  data: UsageRequest[];
  total: number;
  days: number;
  limit: number;
  offset: number;
}

export interface RegistryOptions extends Pick<ManagerConfig, "configPath" | "requestTimeoutMs" | "sessionAffinityTtlMs" | "sessionAffinityMaxEntries"> {
  routingStrategy?: RoutingStrategy;
  rateLimitCooldownMs?: number | string;
  usageDbPath?: string;
}

export interface OpenAIFunctionCall { name?: string; arguments?: string | JsonObject; }
export interface OpenAIToolCall extends JsonObject { id?: string; type?: string; function?: OpenAIFunctionCall; }
export interface OpenAIMessage extends JsonObject {
  role: string; content?: JsonValue; name?: string; tool_call_id?: string;
  tool_calls?: OpenAIToolCall[]; function_call?: OpenAIFunctionCall;
}
export interface CanonicalTextPart { type: "text"; text: string; }
export interface CanonicalJsonPart { type: "json"; value: JsonValue; }
export interface CanonicalToolCallPart { type: "tool_call"; id?: string; name: string; arguments: string | JsonObject; }
export interface CanonicalToolResultPart { type: "tool_result"; id?: string; name?: string; content: CanonicalPart[]; }
export type CanonicalPart = CanonicalTextPart | CanonicalJsonPart | CanonicalToolCallPart | CanonicalToolResultPart;
export interface CanonicalMessage extends Omit<OpenAIMessage, "content"> { content: CanonicalPart[]; }
export interface HttpRequestOptions { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal; timeoutMs?: number; }
export interface HttpTextResponse { status: number; text: string; }
export interface OpenCodeEventSubscriber { onEvent: (event: JsonValue) => void; finish: () => void; }
export interface OpenCodeEventHub { controller: AbortController; subscribers: Set<OpenCodeEventSubscriber>; ready: Promise<void>; done: Promise<void>; }

export interface OpenCodeProviderModel {
  id?: string;
  name?: string;
  [key: string]: unknown;
}
export interface OpenCodeProvider {
  id: string;
  models?: Record<string, OpenCodeProviderModel>;
  [key: string]: unknown;
}
export interface OpenCodeProviderCatalog {
  all?: OpenCodeProvider[];
  connected?: string[];
  default?: Record<string, string>;
  [key: string]: unknown;
}
export interface SelectedModel {
  name: string;
  ref: { providerID: string; modelID: string };
}
export interface OpenAICompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  [key: string]: unknown;
}
