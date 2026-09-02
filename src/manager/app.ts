"use strict";

const http = require("node:http");
import type { IncomingMessage, ServerResponse } from "node:http";
const path = require("node:path");
const { hasValidToken } = require("../shared/auth.ts");
const { json, readJsonBody } = require("../shared/http.ts");
const { createAdminRouter } = require("./admin.ts");
const { completionProxy } = require("./completion-proxy.ts");
const { createRegistry } = require("./registry.ts");
import type { ManagerConfig } from "../shared/types.ts";
import type { Server, Socket } from "node:net";

function managerConfig(env: NodeJS.ProcessEnv = process.env): ManagerConfig {
  return {
    configPath: env.MANAGER_CONFIG || "/etc/opencode-manager.json",
    // The deploy script sets a system-wide path. For local/test runs keep the
    // database beside MANAGER_CONFIG so no privileged directory is required.
    usageDbPath: env.MANAGER_USAGE_DB || "",
    host: env.MANAGER_HOST || "0.0.0.0",
    port: Number(env.MANAGER_PORT || 8090),
    adminKey: env.MANAGER_ADMIN_KEY || "",
    clientKey: env.MANAGER_API_KEY || "",
    requestTimeoutMs: Number(env.MANAGER_REQUEST_TIMEOUT_MS || 15 * 60 * 1000),
    upstreamConnectTimeoutMs: Number(env.MANAGER_UPSTREAM_CONNECT_TIMEOUT_MS || 12_000),
    firstDataTimeoutMs: Number(env.MANAGER_FIRST_DATA_TIMEOUT_MS || 900_000),
    idleDataTimeoutMs: Number(env.MANAGER_IDLE_DATA_TIMEOUT_MS || 900_000),
    healthIntervalMs: Number(env.MANAGER_HEALTH_INTERVAL_MS || 30_000),
    sessionAffinityTtlMs: Number(env.MANAGER_SESSION_AFFINITY_TTL_MS || 60 * 60 * 1000),
    sessionAffinityMaxEntries: Number(env.MANAGER_SESSION_AFFINITY_MAX_ENTRIES || 10_000),
    routingStrategy: (env.MANAGER_ROUTING_STRATEGY as ManagerConfig["routingStrategy"]) || undefined,
    rateLimitCooldownMs: env.MANAGER_RATE_LIMIT_COOLDOWN_MS || undefined,
    webDir: path.join(__dirname, "../../web"),
  };
}

interface ManagerApplication {
  registry: ReturnType<typeof createRegistry>;
  route: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
}

function createManagerApp(config: ManagerConfig = managerConfig()): ManagerApplication {
  const registry = createRegistry(config);
  const admin = createAdminRouter({ registry, adminKey: config.adminKey, webDir: config.webDir });
  const completions = completionProxy({
    registry,
    requestTimeoutMs: config.requestTimeoutMs,
    upstreamConnectTimeoutMs: config.upstreamConnectTimeoutMs,
    firstDataTimeoutMs: config.firstDataTimeoutMs,
    idleDataTimeoutMs: config.idleDataTimeoutMs,
  });

  function clientAuthorized(req) {
    return hasValidToken(req, config.clientKey || registry.config.apiKey || registry.config.adminKey || "");
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) return admin.serveAsset(res, "html");
    if (req.method === "GET" && url.pathname === "/admin.css") return admin.serveAsset(res, "css");
    if (req.method === "GET" && url.pathname === "/admin.js") return admin.serveAsset(res, "js");
    if (req.method === "GET" && url.pathname === "/health") {
      const machines = registry.config.machines.map((machine) => registry.publicMachine(machine));
      return json(res, 200, {
        ok: true,
        machines: machines.length,
        healthy: machines.filter((machine) => machine.status === "healthy" && machine.routingEligible).length,
        coolingDown: machines.filter((machine) => machine.cooldownRemainingMs > 0).length,
      });
    }
    if (url.pathname.startsWith("/admin/")) return admin.route(req, res, url);
    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (!clientAuthorized(req)) return json(res, 401, { error: { message: "Invalid manager API key", type: "authentication_error" } });
      const unknown = registry.config.machines.filter((machine) => machine.enabled !== false && registry.stateFor(machine).status === "unknown");
      if (unknown.length) await Promise.all(unknown.map((machine) => registry.check(machine)));
      const ids = [...new Set(registry.config.machines.flatMap((machine) => registry.stateFor(machine).models))];
      return json(res, 200, { object: "list", data: ids.map((id: string) => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "opencode-manager" })) });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!clientAuthorized(req)) return json(res, 401, { error: { message: "Invalid manager API key", type: "authentication_error" } });
      return completions.proxy(req, res, await readJsonBody(req));
    }
    return json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  }

  return { registry, route };
}

function start(config: ManagerConfig = managerConfig()): Server {
  const app = createManagerApp(config);
  // Persist the normalized registry so legacy `executor` fields disappear
  // without requiring users to edit every registered machine.
  try {
    app.registry.saveSync();
  } catch (error) {
    console.error(`[manager] unable to synchronously persist normalized registry: ${error.message}`);
  }
  void app.registry.save().catch((error) => {
    console.error(`[manager] unable to persist normalized registry: ${error.message}`);
  });
  for (const machine of app.registry.config.machines) app.registry.check(machine);
  const interval = setInterval(() => {
    app.registry.config.machines
      .filter((machine) => machine.enabled !== false)
      .forEach((machine) => app.registry.check(machine));
  }, config.healthIntervalMs);
  interval.unref();
  const server = http.createServer((req, res) => routeSafe(app, req, res));
  // Completion streams may legitimately remain open for many minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 75_000;
  // Transport-only settings: do not add, buffer, or rewrite SSE model frames.
  server.on("connection", (socket: Socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
  });
  let shuttingDown = false;
  const close = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Deploys must not wait for a long-lived completion stream. Destroying
    // active sockets causes the proxy to abort its upstream request and lets
    // systemd restart the manager without a 90-second stop timeout.
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    server.close(() => {
      app.registry.close?.();
      process.exit(0);
    });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    console.log(`opencode manager listening on http://${config.host}:${typeof address === "object" ? address.port : config.port}`);
  });
  return server;
}

async function routeSafe(app: ManagerApplication, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await app.route(req, res);
  } catch (error) {
    if (res.headersSent || res.writableEnded) return;
    json(res, error.status || 500, { error: { message: error.message, type: "manager_error" } });
  }
}

module.exports = { createManagerApp, managerConfig, start };
