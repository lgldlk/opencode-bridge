"use strict";

const http = require("node:http");
const path = require("node:path");
const { hasValidToken } = require("../shared/auth.ts");
const { json, readJsonBody } = require("../shared/http.ts");
const { createAdminRouter } = require("./admin.ts");
const { completionProxy } = require("./completion-proxy.ts");
const { createRegistry } = require("./registry.ts");

function managerConfig(env = process.env) {
  return {
    configPath: env.MANAGER_CONFIG || "/etc/opencode-manager.json",
    host: env.MANAGER_HOST || "0.0.0.0",
    port: Number(env.MANAGER_PORT || 8090),
    adminKey: env.MANAGER_ADMIN_KEY || "",
    clientKey: env.MANAGER_API_KEY || "",
    requestTimeoutMs: Number(env.MANAGER_REQUEST_TIMEOUT_MS || 15 * 60 * 1000),
    healthIntervalMs: Number(env.MANAGER_HEALTH_INTERVAL_MS || 30_000),
    webDir: path.join(__dirname, "../../web"),
  };
}

function createManagerApp(config = managerConfig()) {
  const registry = createRegistry(config);
  const admin = createAdminRouter({ registry, adminKey: config.adminKey, webDir: config.webDir });
  const completions = completionProxy({ registry, requestTimeoutMs: config.requestTimeoutMs });

  function clientAuthorized(req) {
    return hasValidToken(req, config.clientKey || registry.config.apiKey || registry.config.adminKey || "");
  }

  async function route(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) return admin.serveAsset(res, "html");
    if (req.method === "GET" && url.pathname === "/admin.css") return admin.serveAsset(res, "css");
    if (req.method === "GET" && url.pathname === "/admin.js") return admin.serveAsset(res, "js");
    if (req.method === "GET" && url.pathname === "/health") {
      const machines = registry.config.machines.map((machine) => registry.publicMachine(machine));
      return json(res, 200, { ok: true, machines: machines.length, healthy: machines.filter((machine) => machine.status === "healthy").length });
    }
    if (url.pathname.startsWith("/admin/")) return admin.route(req, res, url);
    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (!clientAuthorized(req)) return json(res, 401, { error: { message: "Invalid manager API key", type: "authentication_error" } });
      const unknown = registry.config.machines.filter((machine) => machine.enabled !== false && registry.stateFor(machine).status === "unknown");
      if (unknown.length) await Promise.all(unknown.map((machine) => registry.check(machine)));
      const ids = [...new Set(registry.config.machines.flatMap((machine) => registry.stateFor(machine).models))];
      return json(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "opencode-manager" })) });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!clientAuthorized(req)) return json(res, 401, { error: { message: "Invalid manager API key", type: "authentication_error" } });
      return completions.proxy(req, res, await readJsonBody(req));
    }
    return json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  }

  return { registry, route };
}

function start(config = managerConfig()) {
  const app = createManagerApp(config);
  for (const machine of app.registry.config.machines) app.registry.check(machine);
  const interval = setInterval(() => {
    app.registry.config.machines
      .filter((machine) => machine.enabled !== false)
      .forEach((machine) => app.registry.check(machine));
  }, config.healthIntervalMs);
  interval.unref();
  const server = http.createServer((req, res) => routeSafe(app, req, res));
  // Transport-only settings: do not add, buffer, or rewrite SSE model frames.
  server.on("connection", (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
  });
  const close = () => server.close(() => process.exit(0));
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    console.log(`opencode manager listening on http://${config.host}:${typeof address === "object" ? address.port : config.port}`);
  });
  return server;
}

async function routeSafe(app, req, res) {
  try {
    await app.route(req, res);
  } catch (error) {
    json(res, error.status || 500, { error: { message: error.message, type: "manager_error" } });
  }
}

module.exports = { createManagerApp, managerConfig, start };
