"use strict";

const { httpError } = require("../shared/http.ts");

function createOpenCodeClient({ url, username, password, directory, requestTimeoutMs }) {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  let providerCache;
  let providerCacheAt = 0;

  async function request(requestPath, options: any = {}) {
    const headers = { ...(options.headers || {}), authorization };
    const response = await fetch(`${url}${requestPath}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw httpError(`opencode returned ${response.status}`, response.status, data);
    return data;
  }

  async function providers() {
    if (providerCache && Date.now() - providerCacheAt < 30_000) return providerCache;
    providerCache = await request(`/provider?directory=${encodeURIComponent(directory)}`);
    providerCacheAt = Date.now();
    return providerCache;
  }

  function subscribeEvents(signal, onEvent) {
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = (async () => {
      const response = await fetch(`${url}/event`, { headers: { authorization }, signal });
      if (!response.ok || !response.body) throw new Error(`opencode event stream returned ${response.status}`);
      readyResolve();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
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
      } finally {
        reader.releaseLock();
      }
    })();
    done.catch(readyReject);
    return { ready, done };
  }

  return { providers, request, subscribeEvents };
}

module.exports = { createOpenCodeClient };
