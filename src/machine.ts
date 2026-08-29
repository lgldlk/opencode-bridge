#!/usr/bin/env node
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/$/, "");
const OPENCODE_USERNAME = process.env.OPENCODE_USERNAME || "opencode";
const OPENCODE_PASSWORD = process.env.OPENCODE_PASSWORD || "";
const BRIDGE_KEY = process.env.BRIDGE_KEY || "";
// Empty means "use the provider catalog default". A value may be either a
// provider id (for example `openai`) or an explicit `provider/model` id.
const DEFAULT_MODEL = (process.env.DEFAULT_MODEL || "").trim();
const DIRECTORY = process.env.OPENCODE_DIRECTORY || "/root";
const MAX_BODY = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS || 60 * 60 * 1000);

interface ProviderCatalog {
  all?: Array<{ id: string; models?: Record<string, unknown> }>;
  connected?: string[];
  default?: Record<string, string>;
}

interface SessionInfo { id: string; }

interface OpenCodeMessage {
  parts?: Array<{ type?: string; text?: string }>;
  info?: { tokens?: { input?: number; output?: number } };
}

interface ChatBody {
  model?: string;
  messages?: Array<{ role?: string; content?: string | Array<{ text?: string } | string> }>;
  stream?: boolean;
  temperature?: number;
}
let providerCache: ProviderCatalog | undefined;
let providerCacheAt = 0;

if (!BRIDGE_KEY || !OPENCODE_PASSWORD) {
  console.error("BRIDGE_KEY and OPENCODE_PASSWORD are required");
  process.exit(1);
}

function authOK(req) {
  const bearer = req.headers.authorization || "";
  const key = bearer.startsWith("Bearer ") ? bearer.slice(7) : (req.headers["x-api-key"] || "");
  return typeof key === "string" && key.length === BRIDGE_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(BRIDGE_KEY));
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(Object.assign(new Error("invalid JSON body"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

async function upstream(path, options = {}) {
  const headers = { ...(options.headers || {}), authorization: `Basic ${Buffer.from(`${OPENCODE_USERNAME}:${OPENCODE_PASSWORD}`).toString("base64")}` };
  const response = await fetch(`${OPENCODE_URL}${path}`, { ...options, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const err = new Error(`opencode returned ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function providers() {
  if (providerCache && Date.now() - providerCacheAt < 30_000) return providerCache;
  providerCache = await upstream(`/provider?directory=${encodeURIComponent(DIRECTORY)}`);
  providerCacheAt = Date.now();
  return providerCache;
}

function startEventStream(signal: AbortSignal, onEvent: (event: any) => void) {
  let readyResolve: () => void;
  let readyReject: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = (async () => {
    const response = await fetch(`${OPENCODE_URL}/event`, {
      headers: { authorization: `Basic ${Buffer.from(`${OPENCODE_USERNAME}:${OPENCODE_PASSWORD}`).toString("base64")}` },
      signal,
    });
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
          const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          try { onEvent(JSON.parse(data)); } catch { /* ignore malformed event frames */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  done.catch((error) => readyReject(error));
  return { ready, done };
}

function selectModel(catalog: ProviderCatalog, requested = DEFAULT_MODEL) {
  if (requested && requested.includes("/")) {
    const slash = requested.indexOf("/");
    return { name: requested, ref: { providerID: requested.slice(0, slash), modelID: requested.slice(slash + 1) } };
  }
  const all = catalog.all || [];
  if (requested) {
    const provider = all.find((item) => item.id === requested);
    if (!provider) throw Object.assign(new Error(`Unknown provider: ${requested}`), { status: 400 });
    const modelID = catalog.default?.[requested] || Object.keys(provider.models || {})[0];
    if (!modelID) throw Object.assign(new Error(`Provider has no models: ${requested}`), { status: 503 });
    return { name: `${requested}/${modelID}`, ref: { providerID: requested, modelID } };
  }

  // OpenCode owns the default selection. Prefer its explicit provider map,
  // then fall back to the first catalog entry that has a model.
  for (const [providerID, modelID] of Object.entries(catalog.default || {})) {
    const provider = all.find((item) => item.id === providerID);
    if (provider && modelID && provider.models?.[modelID]) {
      return { name: `${providerID}/${modelID}`, ref: { providerID, modelID } };
    }
  }
  const fallback = all.find((provider) => Object.keys(provider.models || {}).length > 0);
  if (fallback) {
    const modelID = Object.keys(fallback.models || {})[0];
    return { name: `${fallback.id}/${modelID}`, ref: { providerID: fallback.id, modelID } };
  }
  throw Object.assign(new Error("OpenCode provider catalog has no models"), { status: 503 });
}

async function resolveModel(name) {
  const catalog = await providers();
  return selectModel(catalog, name || DEFAULT_MODEL);
}

function promptText(messages) {
  return (messages || []).map((m) => {
    const role = m.role || "user";
    const content = Array.isArray(m.content)
      ? m.content.map((p) => typeof p === "string" ? p : (p.text || "")).join("\n")
      : String(m.content ?? "");
    return `${role.toUpperCase()}: ${content}`;
  }).join("\n\n");
}

function extractText(message) {
  return (message?.parts || []).filter((p) => p && p.type === "text").map((p) => p.text || "").join("");
}

function completion(id, model, text, promptTokens = 0, completionTokens = 0) {
  return {
    id: `chatcmpl-${id}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

async function chat(req, res, body) {
  const selected = await resolveModel(body.model);
  const model = selected.name;
  const routeQuery = `?directory=${encodeURIComponent(DIRECTORY)}`;
  const payload = {
    parts: [{ type: "text", text: promptText(body.messages) }],
    model: selected.ref,
    ...(body.temperature === undefined ? {} : { variant: String(body.temperature) }),
  };
  const id = crypto.randomBytes(12).toString("hex");
  if (body.stream) {
    // Send headers and periodic SSE comments before the upstream model has
    // finished. This prevents idle timeouts in clients/proxies during long
    // reasoning turns while preserving the final OpenAI-shaped payload.
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 5_000);
    const eventController = new AbortController();
    let targetSessionId = "";
    let sentRole = false;
    let streamedText = "";
    const sendDelta = (text) => {
      if (!text || res.writableEnded) return;
      streamedText += text;
      const chunk = { id: `chatcmpl-${id}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { ...(sentRole ? {} : { role: "assistant" }), content: text }, finish_reason: null }] };
      sentRole = true;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    const eventStream = startEventStream(eventController.signal, (event) => {
      const properties = event?.properties;
      if (!targetSessionId || properties?.sessionID !== targetSessionId) return;
      if (event.type === "message.part.delta" && properties.field === "text") sendDelta(String(properties.delta || ""));
    });
    try {
      // Establish the event subscription before creating the session so no
      // initial token/delta can be missed.
      await eventStream.ready;
      const session = await upstream(`/session${routeQuery}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      targetSessionId = session.id;
      const message = await upstream(`/session/${encodeURIComponent(session.id)}/message${routeQuery}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const text = extractText(message);
      if (!streamedText) sendDelta(text);
      const stop = { id: `chatcmpl-${id}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
      res.write(`data: ${JSON.stringify(stop)}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) {
      const message = error?.data?.message || error?.message || "upstream error";
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`);
        res.end("data: [DONE]\n\n");
      }
    } finally {
      eventController.abort();
      clearInterval(heartbeat);
    }
    return;
  }

  const session = await upstream(`/session${routeQuery}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  const message = await upstream(`/session/${encodeURIComponent(session.id)}/message${routeQuery}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const text = extractText(message);
  return json(res, 200, completion(id, model, text, message?.info?.tokens?.input || 0, message?.info?.tokens?.output || 0));
}

async function route(req, res) {
  if (!authOK(req)) return json(res, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/v1/models") {
    const catalog = await providers();
    const connected = new Set(catalog.connected || []);
    const available = (catalog.all || []).filter((provider) => connected.size === 0 || connected.has(provider.id));
    const ids = available.flatMap((provider) => Object.keys(provider.models || {}).map((id) => `${provider.id}/${id}`));
    return json(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "opencode" })) });
  }
  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    try { return await chat(req, res, await readBody(req)); }
    catch (error) {
      console.error(error);
      return json(res, error.status || 502, { error: { message: error.data?.message || error.message, type: "upstream_error", details: error.data } });
    }
  }
  return json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
}

function start() {
  const server = http.createServer((req, res) => route(req, res).catch((error) => json(res, 500, { error: { message: error.message } })));
  const close = () => server.close(() => process.exit(0));
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  server.listen(PORT, HOST, () => console.log(`opencode bridge listening on http://${HOST}:${PORT}`));
  return server;
}

if (require.main === module) start();

module.exports = { selectModel, start };
