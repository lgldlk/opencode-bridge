"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { hasValidToken } = require("../shared/auth.ts");
const { json, readJsonBody } = require("../shared/http.ts");

const ASSETS = {
  html: { file: "admin.html", contentType: "text/html; charset=utf-8" },
  css: { file: "admin.css", contentType: "text/css; charset=utf-8" },
  js: { file: "admin.js", contentType: "text/javascript; charset=utf-8" },
};

function createAdminRouter({ registry, adminKey, webDir }) {
  function authorized(req) {
    return hasValidToken(req, adminKey || registry.config.adminKey || "", "x-admin-key");
  }

  async function serveAsset(res, asset) {
    const target = ASSETS[asset];
    if (!target) return json(res, 404, { error: { message: "Not found" } });
    try {
      const body = await fs.promises.readFile(path.join(webDir, target.file));
      res.writeHead(200, {
        "content-type": target.contentType,
        "cache-control": "no-cache",
        "content-length": body.byteLength,
      });
      res.end(body);
    } catch {
      json(res, 404, { error: { message: "Admin UI is not installed" } });
    }
  }

  async function route(req, res, url) {
    if (!authorized(req)) return json(res, 401, { error: { message: "Invalid manager key", type: "authentication_error" } });
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    const machine = id ? registry.find(id) : null;

    if (req.method === "GET" && parts[1] === "machines" && !id) {
      return json(res, 200, { data: registry.config.machines.map((item) => registry.publicMachine(item)) });
    }
    if (req.method === "POST" && parts[1] === "machines" && id && parts[3] === "check") {
      if (!machine) return json(res, 404, { error: { message: "Machine not found" } });
      await registry.check(machine);
      return json(res, 200, registry.publicMachine(machine));
    }
    if (req.method === "POST" && parts[1] === "machines" && id && ["enable", "disable"].includes(parts[3])) {
      if (!machine) return json(res, 404, { error: { message: "Machine not found" } });
      machine.enabled = parts[3] === "enable";
      await registry.save();
      return json(res, 200, registry.publicMachine(machine));
    }
    if (req.method === "PUT" && parts[1] === "machines" && id) {
      const input = await readJsonBody(req);
      if (!input.baseUrl || !/^https?:\/\//.test(input.baseUrl)) {
        return json(res, 400, { error: { message: "baseUrl must be an http(s) URL" } });
      }
      const next = machine || { id };
      next.name = input.name || next.name || id;
      next.baseUrl = input.baseUrl;
      if (input.apiKey !== undefined) next.apiKey = input.apiKey;
      next.enabled = input.enabled !== false;
      next.weight = Number(input.weight || next.weight || 1);
      if (!machine) registry.config.machines.push(next);
      await registry.save();
      await registry.check(next);
      return json(res, machine ? 200 : 201, registry.publicMachine(next));
    }
    if (req.method === "DELETE" && parts[1] === "machines" && id) {
      if (!machine) return json(res, 404, { error: { message: "Machine not found" } });
      registry.remove(id);
      await registry.save();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: { message: "Not found" } });
  }

  return { route, serveAsset };
}

module.exports = { createAdminRouter };
