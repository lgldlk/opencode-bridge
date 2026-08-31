"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
];

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function createUsageStore({ dbPath, legacyUsage = undefined }) {
  if (!dbPath) throw new Error("usage db path is required");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS usage_totals (
      machine_id TEXT PRIMARY KEY,
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      last_request_at TEXT
    );
    CREATE TABLE IF NOT EXISTS usage_by_model (
      machine_id TEXT NOT NULL,
      model TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      last_request_at TEXT,
      PRIMARY KEY (machine_id, model)
    );
    CREATE INDEX IF NOT EXISTS usage_by_model_model_idx ON usage_by_model(model);
    CREATE TABLE IF NOT EXISTS usage_daily (
      machine_id TEXT NOT NULL,
      usage_day TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      last_request_at TEXT,
      PRIMARY KEY (machine_id, usage_day, model)
    );
    CREATE INDEX IF NOT EXISTS usage_daily_day_idx ON usage_daily(usage_day);
    CREATE TABLE IF NOT EXISTS usage_requests (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      model TEXT,
      stream INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'started',
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS usage_requests_requested_idx ON usage_requests(requested_at DESC);
    CREATE INDEX IF NOT EXISTS usage_requests_machine_idx ON usage_requests(machine_id, requested_at DESC);
  `);

  const selectTotal = db.prepare("SELECT * FROM usage_totals WHERE machine_id = ?");
  const selectModels = db.prepare("SELECT * FROM usage_by_model WHERE machine_id = ? ORDER BY model");
  const selectDaily = db.prepare("SELECT * FROM usage_daily WHERE machine_id = ? AND usage_day >= ? AND model = '' ORDER BY usage_day DESC");
  const insertRequest = db.prepare("INSERT INTO usage_requests (id, machine_id, model, stream, status, requested_at) VALUES (?, ?, ?, ?, 'started', ?)");
  const selectRequest = db.prepare("SELECT * FROM usage_requests WHERE id = ?");
  const finishRequestStatement = db.prepare("UPDATE usage_requests SET status = ?, completed_at = ?, input_tokens = ?, output_tokens = ?, reasoning_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, total_tokens = ? WHERE id = ? AND completed_at IS NULL");
  const listRequestsStatement = db.prepare("SELECT * FROM usage_requests WHERE requested_at >= ? AND (? = '' OR machine_id = ?) ORDER BY requested_at DESC LIMIT ? OFFSET ?");
  const countRequestsStatement = db.prepare("SELECT COUNT(*) AS count FROM usage_requests WHERE requested_at >= ? AND (? = '' OR machine_id = ?)");
  const requestTotalsStatement = db.prepare(`SELECT machine_id, COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens, COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens, COALESCE(SUM(total_tokens), 0) AS total_tokens, MAX(completed_at) AS last_request_at FROM usage_requests WHERE completed_at IS NOT NULL GROUP BY machine_id`);
  const upsertTotal = db.prepare(`
    INSERT INTO usage_totals (
      machine_id, requests, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens, last_request_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET
      requests = usage_totals.requests + excluded.requests,
      input_tokens = usage_totals.input_tokens + excluded.input_tokens,
      output_tokens = usage_totals.output_tokens + excluded.output_tokens,
      reasoning_tokens = usage_totals.reasoning_tokens + excluded.reasoning_tokens,
      cache_read_tokens = usage_totals.cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = usage_totals.cache_write_tokens + excluded.cache_write_tokens,
      total_tokens = usage_totals.total_tokens + excluded.total_tokens,
      last_request_at = excluded.last_request_at
  `);
  const upsertModel = db.prepare(`
    INSERT INTO usage_by_model (
      machine_id, model, requests, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens, last_request_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id, model) DO UPDATE SET
      requests = usage_by_model.requests + excluded.requests,
      input_tokens = usage_by_model.input_tokens + excluded.input_tokens,
      output_tokens = usage_by_model.output_tokens + excluded.output_tokens,
      reasoning_tokens = usage_by_model.reasoning_tokens + excluded.reasoning_tokens,
      cache_read_tokens = usage_by_model.cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = usage_by_model.cache_write_tokens + excluded.cache_write_tokens,
      total_tokens = usage_by_model.total_tokens + excluded.total_tokens,
      last_request_at = excluded.last_request_at
  `);
  const upsertDaily = db.prepare(`
    INSERT INTO usage_daily (
      machine_id, usage_day, model, requests, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens, last_request_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id, usage_day, model) DO UPDATE SET
      requests = usage_daily.requests + excluded.requests,
      input_tokens = usage_daily.input_tokens + excluded.input_tokens,
      output_tokens = usage_daily.output_tokens + excluded.output_tokens,
      reasoning_tokens = usage_daily.reasoning_tokens + excluded.reasoning_tokens,
      cache_read_tokens = usage_daily.cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = usage_daily.cache_write_tokens + excluded.cache_write_tokens,
      total_tokens = usage_daily.total_tokens + excluded.total_tokens,
      last_request_at = excluded.last_request_at
  `);

  function rowToUsage(row) {
    if (!row) return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, requests: 0, lastRequestAt: null };
    return {
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      reasoningTokens: Number(row.reasoning_tokens) || 0,
      cacheReadTokens: Number(row.cache_read_tokens) || 0,
      cacheWriteTokens: Number(row.cache_write_tokens) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      requests: Number(row.requests) || 0,
      lastRequestAt: row.last_request_at || null,
    };
  }

  function modelRows(machineId) {
    return selectModels.all(machineId).map((row) => ({ model: row.model, ...rowToUsage(row) }));
  }

  function read(machineId, days = 30) {
    const total = rowToUsage(selectTotal.get(machineId));
    const byModel = Object.fromEntries(modelRows(machineId).map(({ model, ...value }) => [model, value]));
    const since = new Date(Date.now() - Math.max(1, Number(days) || 30) * 86_400_000).toISOString().slice(0, 10);
    const daily = selectDaily.all(machineId, since).map((row) => ({ day: row.usage_day, ...rowToUsage(row) }));
    return { ...total, byModel, daily };
  }

  function record(machineId, model, value) {
    if (!machineId || !value) return null;
    const usage = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, nonNegativeInteger(value[field])]));
    const now = new Date().toISOString();
    const requestId = start(machineId, model, false, now);
    finish(requestId, usage, "success", now);
    return usage;
  }

  function start(machineId, model, stream = false, requestedAt = new Date().toISOString()) {
    const id = crypto.randomUUID();
    insertRequest.run(id, machineId, model ? String(model).slice(0, 256) : null, stream ? 1 : 0, requestedAt);
    return id;
  }

  function finish(requestId, value, status = "success", completedAt = new Date().toISOString()) {
    const row = selectRequest.get(requestId);
    if (!row || row.completed_at) return false;
    const usage = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, nonNegativeInteger(value?.[field])]));
    const model = row.model || undefined;
    const day = String(row.requested_at).slice(0, 10);
    db.exec("BEGIN IMMEDIATE");
    try {
      finishRequestStatement.run(status, completedAt, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.totalTokens, requestId);
      // Every completed upstream attempt counts as one request, even when the
      // provider omitted usage or returned an error. Token fields remain zero
      // in that case; this keeps the counters consistent with usage_requests.
      upsertTotal.run(row.machine_id, 1, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.totalTokens, completedAt);
      upsertDaily.run(row.machine_id, day, "", 1, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.totalTokens, completedAt);
      if (model) upsertModel.run(row.machine_id, model, 1, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.totalTokens, completedAt);
      if (model) upsertDaily.run(row.machine_id, day, model, 1, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.totalTokens, completedAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  function listRequests({ days = 30, machineId = "", limit = 100, offset = 0 } = {}) {
    const safeDays = Math.max(1, Number(days) || 30);
    const since = new Date(Date.now() - safeDays * 86_400_000).toISOString();
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const filter = machineId ? String(machineId).slice(0, 256) : "";
    const rows = listRequestsStatement.all(since, filter, filter, safeLimit, safeOffset).map((row) => ({
      id: row.id,
      machineId: row.machine_id,
      model: row.model,
      stream: Boolean(row.stream),
      status: row.status,
      requestedAt: row.requested_at,
      completedAt: row.completed_at || null,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      reasoningTokens: Number(row.reasoning_tokens) || 0,
      cacheReadTokens: Number(row.cache_read_tokens) || 0,
      cacheWriteTokens: Number(row.cache_write_tokens) || 0,
      totalTokens: Number(row.total_tokens) || 0,
    }));
    const total = Number(countRequestsStatement.get(since, filter, filter)?.count) || 0;
    return { data: rows, total, days: safeDays, limit: safeLimit, offset: safeOffset };
  }

  function migrateLegacy(input) {
    if (!input || typeof input !== "object") return;
    for (const [machineId, rawValue] of Object.entries(input)) {
      const value: any = rawValue;
      if (!value || selectTotal.get(machineId)) continue;
      const usage = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, nonNegativeInteger(value[field])]));
      const requests = nonNegativeInteger(value.requests);
      if (!requests && !usage.totalTokens && !usage.inputTokens && !usage.outputTokens) continue;
      upsertTotal.run(machineId, requests, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.totalTokens, value.lastRequestAt || null);
      for (const [model, rawModelValue] of Object.entries(value.byModel || {})) {
        const modelValue: any = rawModelValue;
        const modelUsage = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, nonNegativeInteger(modelValue?.[field])]));
        upsertModel.run(machineId, String(model).slice(0, 256), nonNegativeInteger(modelValue?.requests), modelUsage.inputTokens, modelUsage.outputTokens, modelUsage.reasoningTokens, modelUsage.cacheReadTokens, modelUsage.cacheWriteTokens, modelUsage.totalTokens, modelValue?.lastRequestAt || value.lastRequestAt || null);
      }
    }
  }

  migrateLegacy(legacyUsage);

  function summary(machineList, days = 30) {
    const since = new Date(Date.now() - Math.max(1, Number(days) || 30) * 86_400_000).toISOString().slice(0, 10);
    const requestTotals = new Map<string, any>(requestTotalsStatement.all().map((row) => [String(row.machine_id), rowToUsage(row)]));
    const machines = machineList.map((machine) => ({ id: machine.id, name: machine.name || machine.id, ...(requestTotals.get(machine.id) || rowToUsage(null)), byModel: Object.fromEntries(modelRows(machine.id).map(({ model, ...value }) => [model, value])), daily: selectDaily.all(machine.id, since).map((row) => ({ day: row.usage_day, ...rowToUsage(row) })) }));
    const totals = { requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
    for (const machine of machines) for (const key of Object.keys(totals)) totals[key] += Number(machine[key]) || 0;
    const dailyMap = new Map();
    for (const machine of machines) for (const item of machine.daily) {
      const current = dailyMap.get(item.day) || { day: item.day, requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
      for (const key of ["requests", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"]) current[key] += item[key] || 0;
      dailyMap.set(item.day, current);
    }
    return { ...totals, daily: [...dailyMap.values()].sort((a, b) => b.day.localeCompare(a.day)), machines };
  }

  return { close: () => db.close(), finish, listRequests, read, record, start, summary };
}

module.exports = { createUsageStore };
