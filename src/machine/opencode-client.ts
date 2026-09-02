"use strict";

const http = require("node:http");
const https = require("node:https");
import type { IncomingMessage } from "node:http";
const { httpError } = require("../shared/http.ts");
import type { HttpRequestOptions, HttpTextResponse, JsonValue, OpenCodeEventHub, OpenCodeEventSubscriber, OpenCodeProviderCatalog } from "../shared/types.ts";

export interface OpenCodeClientConfig {
  url: string;
  username: string;
  password: string;
  directory: string;
  requestTimeoutMs: number;
}
export interface OpenCodeClient {
  request: (requestPath: string, options?: HttpRequestOptions) => Promise<unknown>;
  providers: () => Promise<OpenCodeProviderCatalog>;
  toolIds: () => Promise<unknown>;
  mcpAdd: (name: string, config: JsonValue) => Promise<unknown>;
  mcpDisconnect: (name: string) => Promise<unknown>;
  mcpConnect: (name: string) => Promise<unknown>;
  promptAsync: (sessionId: string, payload: JsonValue, signal?: AbortSignal) => Promise<unknown>;
  sessionMessages: (sessionId: string, signal?: AbortSignal) => Promise<unknown>;
  sessionAbort: (sessionId: string, signal?: AbortSignal) => Promise<unknown>;
  sessionDelete: (sessionId: string, signal?: AbortSignal) => Promise<unknown>;
  subscribeEvents: (signal: AbortSignal | undefined, onEvent: (event: JsonValue) => void) => { ready: Promise<void>; done: Promise<void> };
}

function mcpRequestTimeoutMs(): number {
  const configured = Number(process.env.OPENCODE_MCP_REQUEST_TIMEOUT_MS || 15_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
}

function createOpenCodeClient({ url, username, password, directory, requestTimeoutMs }: OpenCodeClientConfig): OpenCodeClient {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  // These caches contain only remote capability metadata. Conversation
  // messages, tool calls, and tool results are intentionally never cached
  // here; the OpenAI-compatible caller owns that history.
  let providerCache: OpenCodeProviderCatalog | null = null;
  let providerCacheAt = 0;
  let toolIdsCache: unknown;
  let eventHub: OpenCodeEventHub | null = null;

  function requestText(requestPath: string, options: HttpRequestOptions, headers: Record<string, string>): Promise<HttpTextResponse> {
    const target = new URL(requestPath, `${url}/`);
    const transport = target.protocol === "https:" ? https : http;
    const signal = options.signal;

    return new Promise<HttpTextResponse>((resolve, reject) => {
      let settled = false;
      const cleanup = (): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        return true;
      };
      const resolveOnce = (value: HttpTextResponse): void => {
        if (!cleanup()) return;
        resolve(value);
      };
      const rejectOnce = (error: unknown): void => {
        if (!cleanup()) return;
        reject(error);
      };
      const abortError = () => {
        const reason = signal?.reason;
        if (reason instanceof Error) return reason;
        return Object.assign(new Error("OpenCode request aborted"), { name: "AbortError" });
      };
      const request = transport.request(target, {
        method: options.method || "GET",
        headers,
      }, (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => resolveOnce({
          status: response.statusCode || 0,
          text: Buffer.concat(chunks).toString("utf8"),
        }));
        response.once("error", rejectOnce);
      });
      const onAbort = () => request.destroy(abortError());

      const timeoutMs = Number(options.timeoutMs || requestTimeoutMs);
      request.setTimeout(timeoutMs, () => {
        request.destroy(Object.assign(
          new Error(`OpenCode request timed out after ${timeoutMs}ms`),
          { name: "TimeoutError" },
        ));
      });
      request.once("error", rejectOnce);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      request.end(options.body);
    });
  }

  async function request(requestPath: string, options: HttpRequestOptions = {}): Promise<unknown> {
    const headers = { ...(options.headers || {}), authorization };
    // Node/Undici's global fetch has a five-minute internal header/body idle
    // timeout. OpenCode's synchronous message endpoint can legitimately stay
    // silent for longer while a large prompt is processed, so use the native
    // HTTP client and the configured timeout instead.
    const response = await requestText(requestPath, options, headers);
    const text = response.text;
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (response.status < 200 || response.status >= 300) {
      throw httpError(`opencode returned ${response.status}`, response.status, data);
    }
    return data;
  }

  async function providers() {
    if (providerCache && Date.now() - providerCacheAt < 30_000) return providerCache;
    const value = await request(`/provider?directory=${encodeURIComponent(directory)}`);
    providerCache = value && typeof value === "object" ? value as OpenCodeProviderCatalog : { all: [] };
    providerCacheAt = Date.now();
    return providerCache;
  }

  async function toolIds() {
    if (toolIdsCache) return toolIdsCache;
    toolIdsCache = await request("/experimental/tool/ids");
    return toolIdsCache;
  }

  async function mcpAdd(name: string, config: JsonValue) {
    return request(`/mcp?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, config }),
      timeoutMs: mcpRequestTimeoutMs(),
    });
  }

  async function mcpDisconnect(name: string) {
    return request(`/mcp/${encodeURIComponent(name)}/disconnect?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      timeoutMs: mcpRequestTimeoutMs(),
    });
  }

  async function mcpConnect(name: string) {
    return request(`/mcp/${encodeURIComponent(name)}/connect?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      timeoutMs: mcpRequestTimeoutMs(),
    });
  }

  async function promptAsync(sessionId: string, payload: JsonValue, signal: AbortSignal | undefined = undefined) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return request(`/session/${encodeURIComponent(sessionId)}/prompt_async${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  }

  async function sessionMessages(sessionId: string, signal: AbortSignal | undefined = undefined) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return request(`/session/${encodeURIComponent(sessionId)}/message${query}`, { signal });
  }

  async function sessionAbort(sessionId: string, signal: AbortSignal | undefined = undefined) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return request(`/session/${encodeURIComponent(sessionId)}/abort${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      timeoutMs: 5_000,
      signal,
    });
  }

  async function sessionDelete(sessionId: string, signal: AbortSignal | undefined = undefined) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return request(`/session/${encodeURIComponent(sessionId)}${query}`, {
      method: "DELETE",
      timeoutMs: 5_000,
      signal,
    });
  }

  function startEventHub() {
    const controller = new AbortController();
    let readyResolve: () => void = () => {};
    const hub: OpenCodeEventHub = {
      controller,
      subscribers: new Set<OpenCodeEventSubscriber>(),
      ready: new Promise((resolve) => { readyResolve = resolve; }),
      done: Promise.resolve(),
    };
    eventHub = hub;
    const done = (async () => {
      try {
        let backoffMs = 250;
        while (!controller.signal.aborted) {
          let reader;
          try {
            const eventUrl = `${url}/event?directory=${encodeURIComponent(directory)}`;
            const response = await fetch(eventUrl, {
              headers: {
                authorization,
                accept: "text/event-stream",
                "cache-control": "no-cache",
              },
              signal: controller.signal,
            });
            if (!response.ok || !response.body) throw new Error(`opencode event stream returned ${response.status}`);
            readyResolve();
            backoffMs = 250;
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (!controller.signal.aborted) {
              const next = await reader.read();
              if (next.done) break;
              buffer += decoder.decode(next.value, { stream: true });
              const blocks = buffer.split(/\r?\n\r?\n/);
              buffer = blocks.pop() || "";
              for (const block of blocks) {
                const data = block.split(/\r?\n/)
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim())
                  .join("\n");
                if (!data) continue;
                let event: JsonValue;
                try { event = JSON.parse(data); } catch { continue; }
                for (const subscriber of [...hub.subscribers]) {
                  try { subscriber.onEvent(event); } catch { /* Isolate caller event handlers. */ }
                }
              }
            }
          } catch (error) {
            if (controller.signal.aborted) break;
            // Keep subscribers alive across an OpenCode event-stream restart.
            // Their request-level first/idle timers still provide the bound.
          } finally {
            try { await reader?.cancel(); } catch { /* Connection may already be closed. */ }
            reader?.releaseLock();
          }
          if (controller.signal.aborted) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, backoffMs);
            timer.unref?.();
            const onAbort = () => {
              clearTimeout(timer);
              resolve();
            };
            controller.signal.addEventListener("abort", onAbort, { once: true });
            const cleanup = () => controller.signal.removeEventListener("abort", onAbort);
            setTimeout(cleanup, backoffMs + 1);
          });
          backoffMs = Math.min(5_000, backoffMs * 2);
        }
      } finally {
        if (eventHub === hub) eventHub = null;
        for (const subscriber of [...hub.subscribers]) subscriber.finish();
        hub.subscribers.clear();
      }
    })();
    hub.done = done;
    // The request-level callers observe hub termination through their `done`
    // promises. Keep the shared loop from creating an unhandled rejection.
    hub.done.catch(() => {});
    return hub;
  }

  function subscribeEvents(signal: AbortSignal | undefined, onEvent: (event: JsonValue) => void): { ready: Promise<void>; done: Promise<void> } {
    const hub = eventHub && !eventHub.controller.signal.aborted
      ? eventHub
      : startEventHub();
    let doneResolve: () => void = () => {};
    let finished = false;
    const done = new Promise<void>((resolve) => { doneResolve = resolve; });
    const subscriber = {
      onEvent,
      finish() {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        hub.subscribers.delete(subscriber);
        doneResolve();
      },
    };
    const onAbort = () => {
      subscriber.finish();
      if (hub.subscribers.size === 0 && eventHub === hub) {
        eventHub = null;
        hub.controller.abort();
      }
    };
    hub.subscribers.add(subscriber);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    return { ready: hub.ready, done };
  }

  return {
    mcpAdd,
    mcpConnect,
    mcpDisconnect,
    promptAsync,
    providers,
    request,
    sessionAbort,
    sessionDelete,
    sessionMessages,
    subscribeEvents,
    toolIds,
  };
}

module.exports = { createOpenCodeClient };
