#!/usr/bin/env node
"use strict";

// Control plane for explicitly registered OpenCode bridge machines. It performs
// health-aware failover for transport/server errors, but preserves 429s so a
// provider's quota and retry-after semantics are not hidden.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const CONFIG_PATH = process.env.MANAGER_CONFIG || "/etc/opencode-manager.json";
const HOST = process.env.MANAGER_HOST || "0.0.0.0";
const PORT = Number(process.env.MANAGER_PORT || 8090);
const ADMIN_KEY = process.env.MANAGER_ADMIN_KEY || "";
const CLIENT_KEY = process.env.MANAGER_API_KEY || "";
const REQUEST_TIMEOUT_MS = Number(process.env.MANAGER_REQUEST_TIMEOUT_MS || 15 * 60 * 1000);
const HEALTH_INTERVAL_MS = Number(process.env.MANAGER_HEALTH_INTERVAL_MS || 30_000);
const MAX_BODY = 16 * 1024 * 1024;
const WEB_DIR = path.join(__dirname, "../web");

interface MachineConfig {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  enabled?: boolean;
  weight?: number;
}

interface ManagerConfig {
  adminKey?: string;
  apiKey?: string;
  machines: MachineConfig[];
}

interface MachineRuntime {
  status: "unknown" | "healthy" | "unhealthy";
  failures: number;
  models: string[];
  checkedAt: string | null;
  lastError: string | null;
  latencyMs: number | null;
}

function loadConfig(): ManagerConfig {
  try {
    const value = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<ManagerConfig>;
    if (!Array.isArray(value.machines)) value.machines = [];
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { machines: [] };
    throw error;
  }
}

let config: ManagerConfig = loadConfig();
const state = new Map<string, MachineRuntime>();
let roundRobin = 0;

function machineState(machine: MachineConfig): MachineRuntime {
  if (!state.has(machine.id)) state.set(machine.id, { status: "unknown", failures: 0, models: [], checkedAt: null, lastError: null, latencyMs: null });
  return state.get(machine.id);
}

function timingSafeEquals(value, expected) {
  if (!value || !expected || value.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function adminOK(req) {
  const configured = ADMIN_KEY || config.adminKey || "";
  if (!configured) return false;
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-admin-key"] || "");
  return timingSafeEquals(String(supplied), String(configured));
}

function clientOK(req) {
  const configured = CLIENT_KEY || config.apiKey || config.adminKey || "";
  if (!configured) return false;
  const header = req.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-api-key"] || "");
  return timingSafeEquals(String(supplied), String(configured));
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

async function adminPage(res, asset) {
  const files = { html: "admin.html", css: "admin.css", js: "admin.js" };
  const file = files[asset];
  if (!file) return json(res, 404, { error: { message: "Not found" } });
  try {
    const body = await fs.promises.readFile(path.join(WEB_DIR, file));
    const contentType = asset === "html" ? "text/html; charset=utf-8" : asset === "css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache", "content-length": body.byteLength });
    res.end(body);
  } catch {
    return json(res, 404, { error: { message: "Admin UI is not installed" } });
  }
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
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("invalid JSON body"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function target(machine, requestPath) {
  return `${String(machine.baseUrl).replace(/\/$/, "")}${requestPath}`;
}

async function machineFetch(machine, requestPath, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const headers = { ...(options.headers || {}) };
  delete headers.host;
  if (machine.apiKey) headers.authorization = `Bearer ${machine.apiKey}`;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? (AbortSignal.any ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal)
    : timeoutSignal;
  return fetch(target(machine, requestPath), { ...options, headers, signal });
}

async function checkMachine(machine) {
  const started = Date.now();
  const current = machineState(machine);
  try {
    const response = await machineFetch(machine, "/health", {}, 5_000);
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    const modelsResponse = await machineFetch(machine, "/v1/models", {}, 5_000);
    const models = modelsResponse.ok ? await modelsResponse.json() : { data: [] };
    current.status = "healthy";
    current.failures = 0;
    current.lastError = null;
    current.models = Array.isArray(models.data) ? models.data.map((item) => item.id).filter(Boolean) : [];
    current.checkedAt = new Date().toISOString();
    current.latencyMs = Date.now() - started;
    return true;
  } catch (error) {
    current.status = "unhealthy";
    current.failures += 1;
    current.lastError = error.message;
    current.checkedAt = new Date().toISOString();
    current.latencyMs = Date.now() - started;
    return false;
  }
}

function publicMachine(machine: MachineConfig): Omit<MachineConfig, "apiKey"> & MachineRuntime {
  const current = machineState(machine);
  return { id: machine.id, name: machine.name || machine.id, baseUrl: machine.baseUrl, enabled: machine.enabled !== false, weight: machine.weight || 1, ...current };
}

function candidates(model) {
  const enabled = config.machines.filter((machine) => machine.enabled !== false);
  const matching = model ? enabled.filter((machine) => {
    const models = machineState(machine).models;
    return !models.length || models.includes(model);
  }) : enabled;
  const pool = matching.length ? matching : enabled;
  const healthy = pool.filter((machine) => machineState(machine).status === "healthy");
  const usable = healthy.length ? healthy : pool;
  if (!usable.length) return [];
  const start = roundRobin++ % usable.length;
  return usable.slice(start).concat(usable.slice(0, start));
}

function retryableStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

function requestPath(req) {
  return req.url || "/";
}

async function proxyCompletion(req, res, body) {
  const model = body.model;
  const pool = candidates(model);
  console.log(`[request] stream=${body.stream === true} model=${model || "<default>"} bytes=${req.headers["content-length"] || "?"} remote=${req.socket.remoteAddress || "?"}`);
  if (!pool.length) return json(res, 503, { error: { message: "No enabled machines are registered", type: "service_unavailable" } });
  const payload = JSON.stringify(body);
  if (body.stream === true) return proxyStreamingCompletion(req, res, pool, payload, model);
  let lastError;
  for (const machine of pool) {
    try {
      const response = await machineFetch(machine, "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
      if (response.ok) {
        machineState(machine).status = "healthy";
        machineState(machine).failures = 0;
        const headers = { "content-type": response.headers.get("content-type") || "application/json" };
        res.writeHead(response.status, headers);
        if (response.body) return require("node:stream").Readable.fromWeb(response.body).pipe(res);
        return res.end();
      }
      if (!retryableStatus(response.status)) {
        const text = await response.text();
        const headers = { "content-type": response.headers.get("content-type") || "application/json" };
        res.writeHead(response.status, headers);
        return res.end(text);
      }
      machineState(machine).status = "unhealthy";
      machineState(machine).failures += 1;
      machineState(machine).lastError = `${machine.id} returned ${response.status}`;
      await response.body?.cancel();
      lastError = new Error(`${machine.id} returned ${response.status}`);
    } catch (error) {
      machineState(machine).status = "unhealthy";
      machineState(machine).failures += 1;
      machineState(machine).lastError = error.message;
      lastError = error;
    }
  }
  return json(res, 503, { error: { message: lastError?.message || "All machines failed", type: "service_unavailable" } });
}

/**
 * Keep the client-side HTTP connection alive while a machine is starting a
 * session or waiting for the first model token.  A normal `fetch()` proxy
 * otherwise delays response headers until the upstream response exists, which
 * makes Pi (and many OpenAI SDKs) report a request timeout even though the
 * model is still working.
 */
async function proxyStreamingCompletion(req, res, pool, payload, model) {
  const headers = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
  res.writeHead(200, headers);
  // Force headers through any Node/proxy buffering immediately.
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  let closed = false;
  let activeController = null;
  let upstreamDone = false;
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(": manager-keep-alive\n\n");
  }, 5_000);
  heartbeat.unref?.();
  const onClose = () => {
    closed = true;
    activeController?.abort();
    clearInterval(heartbeat);
  };
  req.once("aborted", onClose);
  res.once("close", onClose);

  const writeSse = (value) => {
    if (!closed && !res.writableEnded) res.write(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
  };
  const finish = () => {
    if (!closed && !res.writableEnded) res.end(upstreamDone ? undefined : "data: [DONE]\n\n");
    clearInterval(heartbeat);
    req.removeListener("aborted", onClose);
    res.removeListener("close", onClose);
  };

  console.log(`[stream] headers-sent model=${model || "<default>"} machines=${pool.map((item) => item.id).join(",")}`);

  let lastError;
  try {
    for (const machine of pool) {
      if (closed) return;
      activeController = new AbortController();
      try {
        const response = await machineFetch(
          machine,
          "/v1/chat/completions",
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: payload,
            signal: activeController.signal,
          },
          REQUEST_TIMEOUT_MS,
        );
        console.log(`[stream] machine=${machine.id} headers=${response.status} after=${Date.now()}`);
        if (response.ok) {
          machineState(machine).status = "healthy";
          machineState(machine).failures = 0;
          if (!response.body) {
            finish();
            return;
          }
          // Do not parse/re-encode frames here.  The machine bridge already
          // emits OpenAI-compatible SSE and preserving bytes avoids buffering.
          const reader = response.body.getReader();
          try {
            while (!closed) {
              const next = await reader.read();
              if (next.done) break;
              if (next.value?.byteLength) {
                const chunk = Buffer.from(next.value);
                if (chunk.toString("utf8").includes("data: [DONE]")) upstreamDone = true;
                if (!res.write(chunk)) break;
              }
            }
          } finally {
            reader.releaseLock();
          }
          finish();
          return;
        }

        const text = await response.text();
        const contentType = response.headers.get("content-type") || "";
        let details;
        try { details = text ? JSON.parse(text) : undefined; } catch { details = undefined; }
        const message = details?.error?.message || text || `${machine.id} returned ${response.status}`;
        if (!retryableStatus(response.status)) {
          // Headers were intentionally sent as 200 to keep the stream alive;
          // represent late upstream failures as an OpenAI SSE error frame.
          writeSse({ error: { message, type: response.status === 429 ? "rate_limit_error" : "upstream_error", code: response.status, ...(contentType ? {} : {}) } });
          finish();
          return;
        }
        machineState(machine).status = "unhealthy";
        machineState(machine).failures += 1;
        machineState(machine).lastError = `${machine.id} returned ${response.status}`;
        lastError = new Error(message);
      } catch (error) {
        if (closed) return;
        machineState(machine).status = "unhealthy";
        machineState(machine).failures += 1;
        machineState(machine).lastError = error.message;
        lastError = error;
      } finally {
        activeController = null;
      }
    }
    if (!closed) writeSse({ error: { message: lastError?.message || "All machines failed", type: "service_unavailable" } });
  } finally {
    finish();
  }
}

async function adminRoute(req, res, url) {
  if (!adminOK(req)) return json(res, 401, { error: { message: "Invalid manager key", type: "authentication_error" } });
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];
  const machine = id ? config.machines.find((item) => item.id === id) : null;

  if (req.method === "GET" && parts[1] === "machines" && !id) return json(res, 200, { data: config.machines.map(publicMachine) });
  if (req.method === "POST" && parts[1] === "machines" && id && parts[3] === "check") {
    if (!machine) return json(res, 404, { error: { message: "Machine not found" } });
    await checkMachine(machine);
    return json(res, 200, publicMachine(machine));
  }
  if (req.method === "POST" && parts[1] === "machines" && id && ["enable", "disable"].includes(parts[3])) {
    if (!machine) return json(res, 404, { error: { message: "Machine not found" } });
    machine.enabled = parts[3] === "enable";
    await saveConfig();
    return json(res, 200, publicMachine(machine));
  }
  if (req.method === "PUT" && parts[1] === "machines" && id) {
    const input = await readBody(req);
    if (!input.baseUrl || !/^https?:\/\//.test(input.baseUrl)) return json(res, 400, { error: { message: "baseUrl must be an http(s) URL" } });
    const next = machine || { id };
    next.name = input.name || next.name || id;
    next.baseUrl = input.baseUrl;
    if (input.apiKey !== undefined) next.apiKey = input.apiKey;
    next.enabled = input.enabled !== false;
    next.weight = Number(input.weight || next.weight || 1);
    if (!machine) config.machines.push(next);
    await saveConfig();
    await checkMachine(next);
    return json(res, machine ? 200 : 201, publicMachine(next));
  }
  if (req.method === "DELETE" && parts[1] === "machines" && id) {
    if (!machine) return json(res, 404, { error: { message: "Machine not found" } });
    config.machines = config.machines.filter((item) => item.id !== id);
    state.delete(id);
    await saveConfig();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: { message: "Not found" } });
}

async function saveConfig() {
  await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await fs.promises.rename(temp, CONFIG_PATH);
}

async function route(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) return adminPage(res, "html");
  if (req.method === "GET" && url.pathname === "/admin.css") return adminPage(res, "css");
  if (req.method === "GET" && url.pathname === "/admin.js") return adminPage(res, "js");
  if (req.method === "GET" && url.pathname === "/health") {
    const machines = config.machines.map(publicMachine);
    return json(res, 200, { ok: true, machines: machines.length, healthy: machines.filter((item) => item.status === "healthy").length });
  }
  if (url.pathname.startsWith("/admin/")) return adminRoute(req, res, url);
  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (!clientOK(req)) return json(res, 401, { error: { message: "Invalid manager API key", type: "authentication_error" } });
    const unknown = config.machines.filter((machine) => machine.enabled !== false && machineState(machine).status === "unknown");
    if (unknown.length) await Promise.all(unknown.map(checkMachine));
    const ids = [...new Set(config.machines.flatMap((machine) => machineState(machine).models))];
    return json(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "opencode-manager" })) });
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    if (!clientOK(req)) return json(res, 401, { error: { message: "Invalid manager API key", type: "authentication_error" } });
    return proxyCompletion(req, res, await readBody(req));
  }
  return json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
}

function start() {
  for (const machine of config.machines) checkMachine(machine);
  const interval = setInterval(() => config.machines.filter((machine) => machine.enabled !== false).forEach((machine) => checkMachine(machine)), HEALTH_INTERVAL_MS);
  interval.unref();
  const server = http.createServer((req, res) => route(req, res).catch((error) => json(res, error.status || 500, { error: { message: error.message, type: "manager_error" } })));
  // SSE must leave the manager as soon as it is written.  These are TCP
  // transport settings only: they do not add, buffer, or rewrite AI frames.
  server.on("connection", (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
  });
  const close = () => server.close(() => process.exit(0));
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  server.listen(PORT, HOST, () => {
    const address = server.address();
    console.log(`opencode manager listening on http://${HOST}:${typeof address === "object" ? address.port : PORT}`);
  });
  return server;
}

if (require.main === module) start();

module.exports = { loadConfig, checkMachine, candidates, resolve: { config: () => config }, start };
