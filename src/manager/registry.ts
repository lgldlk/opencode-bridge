"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeTokenUsage } = require("../shared/usage.ts");
const { createUsageStore } = require("./usage-store.ts");
import type { ManagerConfig, MachineConfig, MachinePublicView, MachineRuntime, RegistryOptions, RoutingConfig, RoutingStrategy, UsageRequestPage, UsageSummary } from "../shared/types.ts";

const ROUTING_STRATEGIES = new Set<RoutingStrategy>(["round_robin", "random", "quota_failover"]);
const DEFAULT_ROUTING: Readonly<RoutingConfig> = Object.freeze({
  strategy: "quota_failover",
  rateLimitCooldownMs: 60 * 60 * 1000,
});

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeStrategy(value: unknown): RoutingStrategy {
  return typeof value === "string" && ROUTING_STRATEGIES.has(value as RoutingStrategy)
    ? value as RoutingStrategy
    : DEFAULT_ROUTING.strategy;
}

interface RegistryConfig extends Partial<ManagerConfig> {
  machines: MachineConfig[];
  routing?: Partial<RoutingConfig>;
  usage?: Record<string, UsageSummary>;
  apiKey?: string;
}

function loadConfig(configPath: string): RegistryConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const value = parsed && typeof parsed === "object" ? parsed as RegistryConfig : { machines: [] };
    if (!Array.isArray(value.machines)) value.machines = [];
    value.machines = value.machines.map((machine: MachineConfig) => {
      const { executor: _legacyExecutor, ...rest } = machine as MachineConfig & { executor?: unknown };
      return rest;
    });
    return value;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { machines: [] };
    throw error;
  }
}

function createRegistry({
  configPath,
  requestTimeoutMs,
  routingStrategy,
  rateLimitCooldownMs,
  usageDbPath,
  sessionAffinityTtlMs = 60 * 60 * 1000,
  sessionAffinityMaxEntries = 10_000,
}: RegistryOptions) {
  let config = loadConfig(configPath);
  const state = new Map<string, MachineRuntime>();
  const sessionAffinity = new Map<string, { machineId: string; lastUsedAt: number }>();
  const healthChecks = new Map<string, Promise<boolean>>();
  let roundRobin = 0;
  let quotaCursor = 0;
  let lastAffinitySweepAt = 0;
  let saveQueue = Promise.resolve();
  const affinityTtlMs = positiveInteger(sessionAffinityTtlMs, 60 * 60 * 1000);
  const affinityMaxEntries = positiveInteger(sessionAffinityMaxEntries, 10_000);
  const usageStore = createUsageStore({
    dbPath: usageDbPath || path.join(path.dirname(configPath), "usage.sqlite"),
    legacyUsage: config.usage,
  });
  if (config.usage) {
    delete config.usage;
    saveConfigWithoutUsage();
  }

  function routing(): RoutingConfig {
    const saved = config.routing || {};
    return {
      strategy: normalizeStrategy(routingStrategy ?? saved.strategy),
      rateLimitCooldownMs: positiveInteger(rateLimitCooldownMs ?? saved.rateLimitCooldownMs, DEFAULT_ROUTING.rateLimitCooldownMs),
    };
  }

  function cooldownUntil(machine: MachineConfig): number | null {
    const timestamp = Date.parse(machine.cooldownUntil || "");
    return Number.isFinite(timestamp) && timestamp > Date.now() ? timestamp : null;
  }

  function isCoolingDown(machine: MachineConfig): boolean {
    return cooldownUntil(machine) !== null;
  }

  function stateFor(machine: MachineConfig): MachineRuntime {
    if (!state.has(machine.id)) {
      state.set(machine.id, {
        status: "unknown",
        failures: 0,
        models: [],
        checkedAt: null,
        lastError: null,
        latencyMs: null,
        usage: usageStore.read(machine.id),
      });
    }
    return state.get(machine.id);
  }

  function recordUsage(machine: MachineConfig, value: unknown, model: string | undefined = undefined) {
    const normalized = normalizeTokenUsage(value);
    if (!normalized) return null;
    const total = usageStore.record(machine.id, model, normalized);
    stateFor(machine).usage = usageStore.read(machine.id);
    return total;
  }

  function usageFor(machine: MachineConfig) {
    return usageStore.read(machine.id);
  }

  function startUsageRequest(machine: MachineConfig, model: string | undefined, stream = false): string {
    return usageStore.start(machine.id, model, stream);
  }

  function finishUsageRequest(requestId: string, value: unknown, status = "success"): boolean {
    return usageStore.finish(requestId, normalizeTokenUsage(value), status);
  }

  function usageRequests(options: Record<string, unknown> = {}): UsageRequestPage {
    return usageStore.listRequests(options);
  }

  function usageSummary(days = 30) {
    return usageStore.summary(config.machines, days);
  }

  function saveConfigWithoutUsage() {
    const temp = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, configPath);
  }

  function publicMachine(machine: MachineConfig): MachinePublicView {
    const runtime = stateFor(machine);
    const until = cooldownUntil(machine);
    return {
      id: machine.id,
      name: machine.name || machine.id,
      baseUrl: machine.baseUrl,
      enabled: machine.enabled !== false,
      weight: machine.weight || 1,
      cooldownUntil: until ? new Date(until).toISOString() : null,
      cooldownRemainingMs: until ? until - Date.now() : 0,
      routingEligible: machine.enabled !== false && !until,
      ...runtime,
      usage: usageStore.read(machine.id),
    };
  }

  function machineUrl(machine: MachineConfig, requestPath: string): string {
    const base = String(machine.baseUrl).replace(/\/$/, "");
    return `${base}${requestPath}`;
  }

  async function fetchMachine(machine: MachineConfig, requestPath: string, options: RequestInit = {}, timeoutMs = requestTimeoutMs): Promise<Response> {
    const headers: Record<string, string> = { ...(options.headers as Record<string, string> || {}) };
    delete headers.host;
    if (machine.apiKey) headers.authorization = `Bearer ${machine.apiKey}`;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? (AbortSignal.any ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal)
      : timeoutSignal;
    return fetch(machineUrl(machine, requestPath), { ...options, headers, signal });
  }

  function markHealthy(machine: MachineConfig): void {
    const runtime = stateFor(machine);
    runtime.status = "healthy";
    runtime.failures = 0;
    runtime.lastError = null;
  }

  function markFailure(machine: MachineConfig, error: unknown): void {
    const runtime = stateFor(machine);
    runtime.status = "unhealthy";
    runtime.failures += 1;
    runtime.lastError = error instanceof Error ? error.message : String(error);
  }

  async function performCheck(machine: MachineConfig): Promise<boolean> {
    const started = Date.now();
    const runtime = stateFor(machine);
    try {
      const health = await fetchMachine(machine, "/health", {}, 5_000);
      if (!health.ok) throw new Error(`health returned ${health.status}`);
      const modelsResponse = await fetchMachine(machine, "/v1/models", {}, 5_000);
      const models = modelsResponse.ok ? await modelsResponse.json() : { data: [] };
      markHealthy(machine);
      runtime.models = Array.isArray(models.data)
        ? models.data.map((item: unknown) => item && typeof item === "object" && "id" in item ? String(item.id) : "").filter(Boolean)
        : [];
      runtime.checkedAt = new Date().toISOString();
      runtime.latencyMs = Date.now() - started;
      return true;
    } catch (error) {
      markFailure(machine, error);
      runtime.checkedAt = new Date().toISOString();
      runtime.latencyMs = Date.now() - started;
      return false;
    }
  }

  function check(machine: MachineConfig): Promise<boolean> {
    const current = healthChecks.get(machine.id);
    if (current) return current;
    const pending = performCheck(machine).finally(() => {
      if (healthChecks.get(machine.id) === pending) healthChecks.delete(machine.id);
    });
    healthChecks.set(machine.id, pending);
    return pending;
  }

  function sweepSessionAffinity(force = false): void {
    const now = Date.now();
    if (!force && now - lastAffinitySweepAt < 60_000 && sessionAffinity.size <= affinityMaxEntries) return;
    lastAffinitySweepAt = now;
    for (const [key, entry] of sessionAffinity) {
      if (
        now - entry.lastUsedAt > affinityTtlMs
        || !config.machines.some((machine) => machine.id === entry.machineId && machine.enabled !== false)
      ) {
        sessionAffinity.delete(key);
      }
    }
    if (sessionAffinity.size <= affinityMaxEntries) return;
    const oldest = [...sessionAffinity.entries()]
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
      .slice(0, sessionAffinity.size - affinityMaxEntries);
    for (const [key] of oldest) sessionAffinity.delete(key);
  }

  function pinnedMachineId(sessionKey: string | undefined): string | undefined {
    if (!sessionKey) return undefined;
    sweepSessionAffinity();
    const key = String(sessionKey);
    const entry = sessionAffinity.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.lastUsedAt > affinityTtlMs) {
      sessionAffinity.delete(key);
      return undefined;
    }
    entry.lastUsedAt = Date.now();
    return entry.machineId;
  }

  function candidates(model: string | undefined, sessionKey: string | undefined = undefined): MachineConfig[] {
    sweepSessionAffinity();
    const allEnabled = config.machines.filter((machine) => machine.enabled !== false);
    const enabled = allEnabled.filter((machine) => !isCoolingDown(machine));
    const matching = model ? enabled.filter((machine) => {
      const models = stateFor(machine).models;
      return !models.length || models.includes(model);
    }) : enabled;
    const pool = matching.length ? matching : enabled;
    const healthy = pool.filter((machine) => stateFor(machine).status === "healthy");
    const usable = healthy.length ? healthy : pool;
    if (!usable.length) return [];
    if (routing().strategy === "quota_failover") {
      // Keep sending requests to one machine until it enters cooldown after a
      // quota/rate-limit response. The next eligible machine then becomes the
      // active slot; when the cooldown expires the original slot is preferred
      // again. This strategy intentionally ignores session affinity so the
      // quota boundary is shared by all callers.
      // Use the health-filtered pool here too. Previously quota failover
      // rebuilt its candidates from every enabled machine, causing a known
      // unhealthy worker to remain first on every request.
      const candidates = usable;
      if (!candidates.length) return [];
      // A provider prompt cache is local to the OpenCode/provider session.
      // Keep a caller's session on the same machine whenever it is eligible;
      // only leave the pin when that machine is cooling down (quota/rate
      // limit) or no longer matches the requested model.
      if (sessionKey) {
        const pinnedId = pinnedMachineId(sessionKey);
        const pinnedIndex = pinnedId ? candidates.findIndex((machine) => machine.id === pinnedId) : -1;
        if (pinnedIndex >= 0) {
          return candidates.slice(pinnedIndex).concat(candidates.slice(0, pinnedIndex));
        }
      }
      const preferredId = allEnabled[quotaCursor % allEnabled.length]?.id;
      const preferredIndex = candidates.findIndex((machine) => machine.id === preferredId);
      const start = preferredIndex >= 0 ? preferredIndex : 0;
      const orderedCandidates = candidates.slice(start).concat(candidates.slice(0, start));
      if (sessionKey && orderedCandidates[0]) {
        rememberSessionMachine(sessionKey, orderedCandidates[0]);
      }
      return orderedCandidates;
    }
    if (routing().strategy === "random" && !sessionKey) {
      const shuffled = [...usable];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const selected = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[selected]] = [shuffled[selected], shuffled[index]];
      }
      return shuffled;
    }
    if (sessionKey) {
      const pinnedId = pinnedMachineId(sessionKey);
      const pinnedIndex = pinnedId ? usable.findIndex((machine) => machine.id === pinnedId) : -1;
      if (pinnedIndex >= 0) return usable.slice(pinnedIndex).concat(usable.slice(0, pinnedIndex));
    }
    const start = roundRobin++ % usable.length;
    const ordered = usable.slice(start).concat(usable.slice(0, start));
    if (sessionKey && ordered[0]) rememberSessionMachine(sessionKey, ordered[0]);
    return ordered;
  }

  function rememberSessionMachine(sessionKey: string | undefined, machine: MachineConfig | undefined): void {
    if (!sessionKey || !machine) return;
    sessionAffinity.set(String(sessionKey), { machineId: machine.id, lastUsedAt: Date.now() });
    sweepSessionAffinity(sessionAffinity.size > affinityMaxEntries);
  }

  async function cooldown(machine: MachineConfig): Promise<string> {
    if (routing().strategy === "quota_failover" && config.machines.length) {
      const index = config.machines.findIndex((item) => item.id === machine.id);
      if (index >= 0) quotaCursor = (index + 1) % config.machines.length;
    }
    const until = new Date(Date.now() + routing().rateLimitCooldownMs).toISOString();
    machine.cooldownUntil = until;
    await save();
    return until;
  }

  function nextCooldownMs() {
    const times = config.machines.map(cooldownUntil).filter((value) => value !== null);
    return times.length ? Math.max(0, Math.min(...times) - Date.now()) : 0;
  }

  function updateRouting(input: Partial<RoutingConfig>): RoutingConfig {
    const current = routing();
    const next = {
      strategy: input.strategy === undefined ? current.strategy : normalizeStrategy(input.strategy),
      rateLimitCooldownMs: input.rateLimitCooldownMs === undefined
        ? current.rateLimitCooldownMs
        : positiveInteger(input.rateLimitCooldownMs, 0),
    };
    if (!next.rateLimitCooldownMs) throw new Error("rateLimitCooldownMs must be a positive integer");
    config.routing = next;
    if (next.strategy === "quota_failover") quotaCursor = 0;
    return routing();
  }

  async function save(): Promise<void> {
    const snapshot = JSON.stringify(config, null, 2) + "\n";
    const operation = saveQueue.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
      const temp = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(temp, snapshot, { mode: 0o600 });
        await fs.promises.rename(temp, configPath);
      } finally {
        await fs.promises.rm(temp, { force: true }).catch(() => {});
      }
    });
    saveQueue = operation;
    return operation;
  }

  function saveSync(): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const temp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, configPath);
  }

  function find(id: string): MachineConfig | undefined {
    return config.machines.find((machine) => machine.id === id);
  }

  function remove(id: string): void {
    config.machines = config.machines.filter((machine) => machine.id !== id);
    state.delete(id);
    for (const [key, entry] of sessionAffinity) {
      if (entry.machineId === id) sessionAffinity.delete(key);
    }
  }

  return {
    candidates,
    check,
    cooldown,
    fetchMachine,
    find,
    get config() { return config; },
    markFailure,
    markHealthy,
    rememberSessionMachine,
    nextCooldownMs,
    publicMachine,
    remove,
    save,
    saveSync,
    stateFor,
    isCoolingDown,
    routing,
    updateRouting,
    recordUsage,
    usageFor,
    usageSummary,
    startUsageRequest,
    finishUsageRequest,
    usageRequests,
    close: () => usageStore.close(),
  };
}

module.exports = { DEFAULT_ROUTING, ROUTING_STRATEGIES, createRegistry, loadConfig };
