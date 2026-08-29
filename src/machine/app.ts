"use strict";

const http = require("node:http");
const { hasValidToken } = require("../shared/auth.ts");
const { json, readJsonBody } = require("../shared/http.ts");
const { createChatHandler } = require("./chat.ts");
const { catalogModelIds } = require("./models.ts");
const { createOpenCodeClient } = require("./opencode-client.ts");

function machineConfig(env = process.env) {
  return {
    port: Number(env.PORT || 8080),
    host: env.HOST || "0.0.0.0",
    opencodeUrl: (env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/$/, ""),
    username: env.OPENCODE_USERNAME || "opencode",
    password: env.OPENCODE_PASSWORD || "",
    bridgeKey: env.BRIDGE_KEY || "",
    defaultModel: (env.DEFAULT_MODEL || "").trim(),
    directory: env.OPENCODE_DIRECTORY || "/root",
    requestTimeoutMs: Number(env.OPENCODE_REQUEST_TIMEOUT_MS || 60 * 60 * 1000),
  };
}

function createMachineApp(config = machineConfig()) {
  if (!config.bridgeKey || !config.password) throw new Error("BRIDGE_KEY and OPENCODE_PASSWORD are required");
  const client = createOpenCodeClient({
    url: config.opencodeUrl,
    username: config.username,
    password: config.password,
    directory: config.directory,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const chat = createChatHandler({ client, directory: config.directory, defaultModel: config.defaultModel });

  async function route(req, res) {
    if (!hasValidToken(req, config.bridgeKey)) {
      return json(res, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
    }
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && req.url === "/v1/models") {
      const ids = catalogModelIds(await client.providers());
      return json(res, 200, {
        object: "list",
        data: ids.map((id) => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "opencode" })),
      });
    }
    if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
      try {
        return await chat.handle(req, res, await readJsonBody(req));
      } catch (error) {
        console.error(error);
        return json(res, error.status || 502, {
          error: { message: error.data?.message || error.message, type: "upstream_error", details: error.data },
        });
      }
    }
    return json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  }

  return { route };
}

function start(config = machineConfig()) {
  const app = createMachineApp(config);
  const server = http.createServer((req, res) => routeSafe(app, req, res));
  const close = () => server.close(() => process.exit(0));
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  server.listen(config.port, config.host, () => console.log(`opencode bridge listening on http://${config.host}:${config.port}`));
  return server;
}

async function routeSafe(app, req, res) {
  try {
    await app.route(req, res);
  } catch (error) {
    json(res, error.status || 500, { error: { message: error.message, type: "bridge_error" } });
  }
}

module.exports = { createMachineApp, machineConfig, start };
