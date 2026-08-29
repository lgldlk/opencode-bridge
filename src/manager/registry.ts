"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadConfig(configPath) {
  try {
    const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!Array.isArray(value.machines)) value.machines = [];
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { machines: [] };
    throw error;
  }
}

function createRegistry({ configPath, requestTimeoutMs }) {
  let config = loadConfig(configPath);
  const state = new Map();
  let roundRobin = 0;

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
    return {
      id: machine.id,
      name: machine.name || machine.id,
      baseUrl: machine.baseUrl,
      enabled: machine.enabled !== false,
      weight: machine.weight || 1,
      ...runtime,
    };
  }

  function machineUrl(machine, requestPath) {
    return `${String(machine.baseUrl).replace(/\/$/, "")}${requestPath}`;
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
    const enabled = config.machines.filter((machine) => machine.enabled !== false);
    const matching = model ? enabled.filter((machine) => {
      const models = stateFor(machine).models;
      return !models.length || models.includes(model);
    }) : enabled;
    const pool = matching.length ? matching : enabled;
    const healthy = pool.filter((machine) => stateFor(machine).status === "healthy");
    const usable = healthy.length ? healthy : pool;
    if (!usable.length) return [];
    const start = roundRobin++ % usable.length;
    return usable.slice(start).concat(usable.slice(0, start));
  }

  async function save() {
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    const temp = `${configPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await fs.promises.rename(temp, configPath);
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
    fetchMachine,
    find,
    get config() { return config; },
    markFailure,
    markHealthy,
    publicMachine,
    remove,
    save,
    stateFor,
  };
}

module.exports = { createRegistry, loadConfig };
