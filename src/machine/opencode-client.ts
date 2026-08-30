"use strict";

const http = require("node:http");
const https = require("node:https");
const { httpError } = require("../shared/http.ts");

function createOpenCodeClient({ url, username, password, directory, requestTimeoutMs }) {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  // These caches contain only remote capability metadata. Conversation
  // messages, tool calls, and tool results are intentionally never cached
  // here; the OpenAI-compatible caller owns that history.
  let providerCache;
  let providerCacheAt = 0;
  let toolIdsCache;

  function requestText(requestPath, options, headers) {
    const target = new URL(requestPath, `${url}/`);
    const transport = target.protocol === "https:" ? https : http;
    const signal = options.signal;

    return new Promise<any>((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      const abortError = () => {
        const reason = signal?.reason;
        if (reason instanceof Error) return reason;
        return Object.assign(new Error("OpenCode request aborted"), { name: "AbortError" });
      };
      const request = transport.request(target, {
        method: options.method || "GET",
        headers,
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => finish(resolve, {
          status: response.statusCode || 0,
          text: Buffer.concat(chunks).toString("utf8"),
        }));
        response.once("error", (error) => finish(reject, error));
      });
      const onAbort = () => request.destroy(abortError());

      const timeoutMs = Number(options.timeoutMs || requestTimeoutMs);
      request.setTimeout(timeoutMs, () => {
        request.destroy(Object.assign(
          new Error(`OpenCode request timed out after ${timeoutMs}ms`),
          { name: "TimeoutError" },
        ));
      });
      request.once("error", (error) => finish(reject, error));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      request.end(options.body);
    });
  }

  async function request(requestPath, options: any = {}) {
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
    providerCache = await request(`/provider?directory=${encodeURIComponent(directory)}`);
    providerCacheAt = Date.now();
    return providerCache;
  }

  async function toolIds() {
    if (toolIdsCache) return toolIdsCache;
    toolIdsCache = await request("/experimental/tool/ids");
    return toolIdsCache;
  }

  async function mcpAdd(name, config) {
    return request(`/mcp?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, config }),
    });
  }

  async function mcpDisconnect(name) {
    return request(`/mcp/${encodeURIComponent(name)}/disconnect?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  }

  async function mcpConnect(name) {
    return request(`/mcp/${encodeURIComponent(name)}/connect?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  }

  async function promptAsync(sessionId, payload, signal = undefined) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return request(`/session/${encodeURIComponent(sessionId)}/prompt_async${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  }

  async function sessionMessages(sessionId, signal = undefined) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return request(`/session/${encodeURIComponent(sessionId)}/message${query}`, { signal });
  }

  async function sessionAbort(sessionId, signal = undefined) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return request(`/session/${encodeURIComponent(sessionId)}/abort${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      timeoutMs: 5_000,
      signal,
    });
  }

  async function sessionDelete(sessionId, signal = undefined) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return request(`/session/${encodeURIComponent(sessionId)}${query}`, {
      method: "DELETE",
      timeoutMs: 5_000,
      signal,
    });
  }

  function subscribeEvents(signal, onEvent) {
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = (async () => {
      let reader;
      try {
        const eventUrl = `${url}/event?directory=${encodeURIComponent(directory)}`;
        const response = await fetch(eventUrl, {
          headers: {
            authorization,
            accept: "text/event-stream",
            "cache-control": "no-cache",
          },
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`opencode event stream returned ${response.status}`);
        readyResolve();
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
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
            try { onEvent(JSON.parse(data)); } catch { /* Ignore malformed OpenCode events. */ }
          }
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        try { await reader?.cancel(); } catch { /* The abort path may already have closed it. */ }
        reader?.releaseLock();
      }
    })();
    done.catch(readyReject);
    return { ready, done };
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
