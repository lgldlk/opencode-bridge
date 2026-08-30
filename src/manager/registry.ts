"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROUTING_STRATEGIES = new Set(["round_robin", "random"]);
const DEFAULT_ROUTING = Object.freeze({
  strategy: "round_robin",
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

function createRegistry({ configPath, requestTimeoutMs, routingStrategy, rateLimitCooldownMs }) {
  let config = loadConfig(configPath);
  const state = new Map();
  let roundRobin = 0;

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
      });
    }
    return state.get(machine.id);
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

  function candidates(model) {
    const enabled = config.machines.filter((machine) => machine.enabled !== false && !isCoolingDown(machine));
    const matching = model ? enabled.filter((machine) => {
      const models = stateFor(machine).models;
      return !models.length || models.includes(model);
    }) : enabled;
    const pool = matching.length ? matching : enabled;
    const healthy = pool.filter((machine) => stateFor(machine).status === "healthy");
    const usable = healthy.length ? healthy : pool;
    if (!usable.length) return [];
    if (routing().strategy === "random") {
      const shuffled = [...usable];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const selected = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[selected]] = [shuffled[selected], shuffled[index]];
      }
      return shuffled;
    }
    const start = roundRobin++ % usable.length;
    return usable.slice(start).concat(usable.slice(0, start));
  }

  async function cooldown(machine) {
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
  };
}

module.exports = { DEFAULT_ROUTING, ROUTING_STRATEGIES, createRegistry, loadConfig };
