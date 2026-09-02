"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { hasValidToken } = require("../shared/auth.ts");
const { json, readJsonBody } = require("../shared/http.ts");
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MachineConfig, MachinePublicView, RoutingConfig, UsageRequestPage, UsageSummary } from "../shared/types.ts";

const ASSETS = {
  html: { file: "admin.html", contentType: "text/html; charset=utf-8" },
  css: { file: "admin.css", contentType: "text/css; charset=utf-8" },
  js: { file: "admin.js", contentType: "text/javascript; charset=utf-8" },
};
type AssetName = keyof typeof ASSETS;
interface AdminRegistry {
  config: { adminKey?: string; apiKey?: string; machines: MachineConfig[] };
  find: (id: string) => MachineConfig | undefined;
  routing: () => RoutingConfig;
  updateRouting: (value: Record<string, unknown>) => RoutingConfig;
  save: () => Promise<void>;
  usageSummary: (days: number) => UsageSummary;
  usageRequests: (options: Record<string, unknown>) => UsageRequestPage;
  publicMachine: (machine: MachineConfig) => MachinePublicView;
  check: (machine: MachineConfig) => Promise<boolean>;
  remove: (id: string) => void;
}

function createAdminRouter({ registry, adminKey, webDir }: { registry: AdminRegistry; adminKey: string; webDir: string }) {
  function authorized(req: IncomingMessage): boolean {
    return hasValidToken(req, adminKey || registry.config.adminKey || "", "x-admin-key");
  }

  async function serveAsset(res: ServerResponse, asset: AssetName): Promise<unknown> {
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

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<unknown> {
    if (!authorized(req)) return json(res, 401, { error: { message: "Invalid manager key", type: "authentication_error" } });
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    const machine = id ? registry.find(id) : null;

    if (parts[1] === "routing" && !id) {
      if (req.method === "GET") return json(res, 200, registry.routing());
      if (req.method === "PUT") {
        const input = await readJsonBody(req);
        if (input.strategy !== undefined && !["round_robin", "random", "quota_failover"].includes(input.strategy)) {
          return json(res, 400, { error: { message: "strategy must be round_robin, random, or quota_failover" } });
        }
        if (input.rateLimitCooldownMs !== undefined && (!Number.isFinite(Number(input.rateLimitCooldownMs)) || Number(input.rateLimitCooldownMs) <= 0)) {
          return json(res, 400, { error: { message: "rateLimitCooldownMs must be a positive number" } });
        }
        const routing = registry.updateRouting(input);
        await registry.save();
        return json(res, 200, routing);
      }
    }

    if (req.method === "GET" && parts[1] === "usage" && !id) {
      const requestedDays = Number(url.searchParams.get("days") || 30);
      const days = Number.isFinite(requestedDays) ? Math.min(366, Math.max(1, Math.floor(requestedDays))) : 30;
      return json(res, 200, registry.usageSummary(days));
    }

    if (req.method === "GET" && parts[1] === "requests" && !id) {
      const daysValue = Number(url.searchParams.get("days") || 30);
      const limitValue = Number(url.searchParams.get("limit") || 100);
      const offsetValue = Number(url.searchParams.get("offset") || 0);
      const days = Number.isFinite(daysValue) ? Math.min(366, Math.max(1, Math.floor(daysValue))) : 30;
      const limit = Number.isFinite(limitValue) ? Math.min(500, Math.max(1, Math.floor(limitValue))) : 100;
      const offset = Number.isFinite(offsetValue) ? Math.max(0, Math.floor(offsetValue)) : 0;
      return json(res, 200, registry.usageRequests({ days, limit, offset, machineId: url.searchParams.get("machineId") || "" }));
    }

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
      const next: MachineConfig = machine || { id, baseUrl: "", apiKey: "" };
      next.name = input.name || next.name || id;
      next.baseUrl = input.baseUrl;
      if (input.apiKey !== undefined) next.apiKey = input.apiKey;
      delete next.executor;
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
