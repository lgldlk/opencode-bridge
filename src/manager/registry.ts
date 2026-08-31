"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeTokenUsage } = require("../shared/usage.ts");
const { createUsageStore } = require("./usage-store.ts");

const ROUTING_STRATEGIES = new Set(["round_robin", "random", "quota_failover"]);
const DEFAULT_ROUTING = Object.freeze({
  strategy: "quota_failover",
  rateLimitCooldownMs: 60 * 60 * 1000,
});

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeStrategy(value) {
  return ROUTING_STRATEGIES.has(value) ? value : DEFAULT_ROUTING.strategy;
}

function loadConfig(configPath) {
  try {
    const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!Array.isArray(value.machines)) value.machines = [];
    value.machines = value.machines.map(({ executor: _legacyExecutor, ...machine }) => machine);
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { machines: [] };
    throw error;
  }
}

function createRegistry({ configPath, requestTimeoutMs, routingStrategy, rateLimitCooldownMs, usageDbPath }) {
  let config = loadConfig(configPath);
  const state = new Map();
  const sessionAffinity = new Map();
  let roundRobin = 0;
  let quotaCursor = 0;
  const usageStore = createUsageStore({
    dbPath: usageDbPath || path.join(path.dirname(configPath), "usage.sqlite"),
    legacyUsage: config.usage,
  });
  if (config.usage) {
    delete config.usage;
    saveConfigWithoutUsage();
  }

  function routing() {
    const saved = config.routing || {};
    return {
      strategy: normalizeStrategy(routingStrategy ?? saved.strategy),
      rateLimitCooldownMs: positiveInteger(rateLimitCooldownMs ?? saved.rateLimitCooldownMs, DEFAULT_ROUTING.rateLimitCooldownMs),
    };
  }

  function cooldownUntil(machine) {
    const timestamp = Date.parse(machine.cooldownUntil || "");
    return Number.isFinite(timestamp) && timestamp > Date.now() ? timestamp : null;
  }

  function isCoolingDown(machine) {
    return cooldownUntil(machine) !== null;
  }

  function stateFor(machine) {
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

  function recordUsage(machine, value, model = undefined) {
    const normalized = normalizeTokenUsage(value);
    if (!normalized) return null;
    const total = usageStore.record(machine.id, model, normalized);
    stateFor(machine).usage = usageStore.read(machine.id);
    return total;
  }

  function usageFor(machine) {
    return usageStore.read(machine.id);
  }

  function startUsageRequest(machine, model, stream = false) {
    return usageStore.start(machine.id, model, stream);
  }

  function finishUsageRequest(requestId, value, status = "success") {
    return usageStore.finish(requestId, normalizeTokenUsage(value), status);
  }

  function usageRequests(options = {}) {
    return usageStore.listRequests(options);
  }

  function usageSummary(days = 30) {
    return usageStore.summary(config.machines, days);
  }

  function saveConfigWithoutUsage() {
    const temp = `${configPath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, configPath);
  }

  function publicMachine(machine) {
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

  function machineUrl(machine, requestPath) {
    const base = String(machine.baseUrl).replace(/\/$/, "");
    return `${base}${requestPath}`;
  }

  async function fetchMachine(machine, requestPath, options: any = {}, timeoutMs = requestTimeoutMs) {
    const headers = { ...(options.headers || {}) };
    delete headers.host;
    if (machine.apiKey) headers.authorization = `Bearer ${machine.apiKey}`;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? (AbortSignal.any ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal)
      : timeoutSignal;
    return fetch(machineUrl(machine, requestPath), { ...options, headers, signal });
  }

  function markHealthy(machine) {
    const runtime = stateFor(machine);
    runtime.status = "healthy";
    runtime.failures = 0;
    runtime.lastError = null;
  }

  function markFailure(machine, error) {
    const runtime = stateFor(machine);
    runtime.status = "unhealthy";
    runtime.failures += 1;
    runtime.lastError = error instanceof Error ? error.message : String(error);
  }

  async function check(machine) {
    const started = Date.now();
    const runtime = stateFor(machine);
    try {
      const health = await fetchMachine(machine, "/health", {}, 5_000);
      if (!health.ok) throw new Error(`health returned ${health.status}`);
      const modelsResponse = await fetchMachine(machine, "/v1/models", {}, 5_000);
      const models = modelsResponse.ok ? await modelsResponse.json() : { data: [] };
      markHealthy(machine);
      runtime.models = Array.isArray(models.data) ? models.data.map((item) => item.id).filter(Boolean) : [];
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

  function candidates(model, sessionKey = undefined) {
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
      const ordered = allEnabled.filter((machine) => !isCoolingDown(machine));
      const matchingOrdered = model ? ordered.filter((machine) => {
        const models = stateFor(machine).models;
        return !models.length || models.includes(model);
      }) : ordered;
      const candidates = matchingOrdered.length ? matchingOrdered : ordered;
      if (!candidates.length) return [];
      const preferredId = allEnabled[quotaCursor % allEnabled.length]?.id;
      const preferredIndex = candidates.findIndex((machine) => machine.id === preferredId);
      const start = preferredIndex >= 0 ? preferredIndex : 0;
      return candidates.slice(start).concat(candidates.slice(0, start));
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
      const pinnedId = sessionAffinity.get(String(sessionKey));
      const pinnedIndex = pinnedId ? usable.findIndex((machine) => machine.id === pinnedId) : -1;
      if (pinnedIndex >= 0) return usable.slice(pinnedIndex).concat(usable.slice(0, pinnedIndex));
    }
    const start = roundRobin++ % usable.length;
    const ordered = usable.slice(start).concat(usable.slice(0, start));
    if (sessionKey && ordered[0]) sessionAffinity.set(String(sessionKey), ordered[0].id);
    return ordered;
  }

  async function cooldown(machine) {
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

  function updateRouting(input) {
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

  async function save() {
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    const temp = `${configPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await fs.promises.rename(temp, configPath);
  }

  function saveSync() {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const temp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, configPath);
  }

  function find(id) {
    return config.machines.find((machine) => machine.id === id);
  }

  function remove(id) {
    config.machines = config.machines.filter((machine) => machine.id !== id);
    state.delete(id);
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
