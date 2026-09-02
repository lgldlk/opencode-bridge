"use strict";

const crypto = require("node:crypto");
const { once } = require("node:events");
const { json, sseHeaders, sseHeartbeat, SSE_HEARTBEAT_INTERVAL_MS } = require("../shared/http.ts");
const { machineSessionHeaders, requestSessionContext } = require("../shared/session.ts");
const { normalizeTokenUsage } = require("../shared/usage.ts");
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MachineConfig, TokenUsage } from "../shared/types.ts";
import type { SessionBody, SessionContext } from "../shared/session.ts";

interface CompletionRegistry {
  candidates: (model?: string, sessionKey?: string | null) => MachineConfig[];
  nextCooldownMs: () => number;
  startUsageRequest: (machine: MachineConfig, model?: string, stream?: boolean) => string;
  finishUsageRequest: (id: string, value: unknown, status?: string) => boolean;
  fetchMachine: (machine: MachineConfig, path: string, options?: RequestInit, timeoutMs?: number) => Promise<Response>;
  markHealthy: (machine: MachineConfig) => void;
  markFailure: (machine: MachineConfig, error: unknown) => void;
  cooldown: (machine: MachineConfig) => Promise<string>;
  rememberSessionMachine?: (key: string | null, machine: MachineConfig) => void;
}
interface CompletionBody extends SessionBody {
  model?: string;
  stream?: boolean;
}

function retryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function rateLimitHeaders(registry: CompletionRegistry): Record<string, string> {
  const remainingMs = registry.nextCooldownMs();
  return remainingMs ? { "retry-after": String(Math.max(1, Math.ceil(remainingMs / 1000))) } : {};
}

function completionProxy({ registry, requestTimeoutMs, upstreamConnectTimeoutMs = 12_000, firstDataTimeoutMs = 900_000, idleDataTimeoutMs = firstDataTimeoutMs }: { registry: CompletionRegistry; requestTimeoutMs: number; upstreamConnectTimeoutMs?: number; firstDataTimeoutMs?: number; idleDataTimeoutMs?: number }) {
  async function proxy(req: IncomingMessage, res: ServerResponse, body: CompletionBody): Promise<unknown> {
    const model = body.model;
    const sessionContext = requestSessionContext(req, body);
    const sessionKey = sessionContext.routingKey;
    const traceId = sessionContext.requestId || crypto.randomUUID();
    const pool = registry.candidates(model, sessionKey);
    console.log(
      `[request] id=${traceId} stream=${body.stream === true} `
      + `model=${model || "<default>"} bytes=${req.headers["content-length"] || "?"} `
      + `affinity=${sessionContext.affinityKey || "-"} cache=${sessionContext.cacheKey || "-"}`,
    );
    if (!pool.length) {
      const headers = rateLimitHeaders(registry);
      if (Object.keys(headers).length) {
        if (body.stream === true) {
          res.writeHead(200, sseHeaders());
          res.end(`data: ${JSON.stringify({ error: { message: "All eligible machines are cooling down", type: "rate_limit_error", retry_after: Number(headers["retry-after"]) } })}\n\ndata: [DONE]\n\n`);
          return;
        }
        return json(res, 429, { error: { message: "All eligible machines are cooling down", type: "rate_limit_error" } }, headers);
      }
      return json(res, 503, { error: { message: "No enabled machines are registered", type: "service_unavailable" } });
    }
    const payload = JSON.stringify(body);
    return body.stream === true
      ? proxyStream(req, res, pool, payload, model, sessionContext, traceId)
      : proxyJson(res, pool, payload, model, sessionContext, traceId);
  }

  async function proxyJson(res: ServerResponse, pool: MachineConfig[], payload: string, model: string | undefined, sessionContext: SessionContext, traceId: string): Promise<unknown> {
    let lastError: Error | undefined;
    let rateLimited = null;
    let otherFailure = false;
    for (const machine of pool) {
      const requestId = registry.startUsageRequest(machine, model, false);
      try {
        const response = await registry.fetchMachine(machine, "/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-client-request-id": traceId,
            ...machineSessionHeaders(sessionContext),
          },
          body: payload,
        });
        if (response.ok) {
          registry.markHealthy(machine);
          // Pi commonly supplies only prompt_cache_key. routingKey includes
          // that cache partition, while affinityKey does not. Remember the
          // actual successful failover target for either form.
          registry.rememberSessionMachine?.(sessionContext.routingKey, machine);
          res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json" });
          const text = await response.text();
          let value: { usage?: unknown } | null = null;
          try {
            value = text ? JSON.parse(text) : null;
          } catch { /* preserve non-JSON upstream responses */ }
          registry.finishUsageRequest(requestId, value?.usage, "success");
          return res.end(text);
        }
        if (response.status === 429) {
          const text = await response.text();
          let details;
          try { details = text ? JSON.parse(text) : undefined; } catch { details = undefined; }
          rateLimited = details?.error?.message || text || `${machine.id} is rate limited`;
          registry.finishUsageRequest(requestId, null, "rate_limited");
          await registry.cooldown(machine);
          continue;
        }
        if (!retryableStatus(response.status)) {
          registry.finishUsageRequest(requestId, null, `http_${response.status}`);
          res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json" });
          return res.end(await response.text());
        }
        await response.body?.cancel();
        registry.finishUsageRequest(requestId, null, `http_${response.status}`);
        lastError = new Error(`${machine.id} returned ${response.status}`);
        otherFailure = true;
        registry.markFailure(machine, lastError);
      } catch (error) {
        registry.finishUsageRequest(requestId, null, error?.name === "AbortError" ? "aborted" : "error");
        registry.markFailure(machine, error);
        lastError = error;
        otherFailure = true;
      }
    }
    if (rateLimited && !otherFailure) {
      return json(res, 429, { error: { message: rateLimited, type: "rate_limit_error" } }, rateLimitHeaders(registry));
    }
    return json(res, 503, { error: { message: lastError?.message || "All machines failed", type: "service_unavailable" } });
  }

  function classifySseBlock(block: string): { model: boolean; done: boolean; heartbeat: boolean; internalUsage?: boolean; usage?: TokenUsage | null; error?: string; errorType?: string; errorCode?: number } {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return { model: false, done: false, heartbeat: false };
    if (data === "[DONE]") return { model: false, done: true, heartbeat: false };
    try {
      const value = JSON.parse(data);
      const heartbeat = typeof value?.id === "string" && value.id.startsWith("sse-");
      const internalUsage = value?.object === "bridge.usage";
      // Any non-heartbeat OpenAI choice frame is real upstream data, including
      // role-only/empty deltas and finish frames. Do not drop those fields just
      // because they carry no text; clients use them for tool and stream state.
      const model = !heartbeat && Array.isArray(value?.choices) && value.choices.length > 0;
      return {
        model,
        done: false,
        heartbeat,
        internalUsage,
        usage: normalizeTokenUsage(value?.usage),
        error: value?.error?.message ? String(value.error.message) : undefined,
        errorType: value?.error?.type ? String(value.error.type) : undefined,
        errorCode: Number.isInteger(Number(value?.error?.code)) ? Number(value.error.code) : undefined,
      };
    } catch {
      return { model: false, done: false, heartbeat: false };
    }
  }

  async function proxyStream(req: IncomingMessage, res: ServerResponse, pool: MachineConfig[], payload: string, model: string | undefined, sessionContext: SessionContext, traceId: string): Promise<void> {
    res.writeHead(200, sseHeaders());
    res.flushHeaders?.();
    let closed = false;
    let activeController: AbortController | null = null;
    let upstreamDone = false;
    const heartbeatFrame = sseHeartbeat("manager-keep-alive");
    const heartbeatComment = sseHeartbeat("manager-keep-alive", false);
    // Send a padded SSE comment. It keeps intermediary buffers flushing
    // without becoming an OpenAI message/response ID in the client.
    res.write(heartbeatFrame);
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(heartbeatComment);
    }, SSE_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    const onClose = () => {
      if (!closed) console.log(`[stream] id=${traceId} client-closed model=${model || "<default>"}`);
      closed = true;
      activeController?.abort();
      clearInterval(heartbeat);
    };
    req.once("aborted", onClose);
    res.once("close", onClose);
    const writeSse = (value: unknown): void => {
      if (!closed && !res.writableEnded) res.write(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
    };
    const writeChunk = async (chunk: string | Uint8Array): Promise<boolean> => {
      if (closed || res.writableEnded) return false;
      if (res.write(chunk)) return true;
      // Do not truncate an SSE response when the client socket applies backpressure.
      await Promise.race([once(res, "drain"), once(res, "close")]);
      return !closed && !res.writableEnded;
    };
    const finish = () => {
      if (!closed && !res.writableEnded) res.end(upstreamDone ? undefined : "data: [DONE]\n\n");
      clearInterval(heartbeat);
      req.removeListener("aborted", onClose);
      res.removeListener("close", onClose);
    };

    console.log(`[stream] id=${traceId} headers-sent model=${model || "<default>"} machines=${pool.map((item) => item.id).join(",")}`);
    let lastError;
    let rateLimited = null;
    let otherFailure = false;
    try {
      for (const machine of pool) {
        if (closed) return;
        const requestId = registry.startUsageRequest(machine, model, true);
        activeController = new AbortController();
        const connectTimer = setTimeout(() => activeController?.abort(new Error("upstream response headers timed out")), upstreamConnectTimeoutMs);
        connectTimer.unref?.();
        try {
          const response = await registry.fetchMachine(machine, "/v1/chat/completions", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              "x-client-request-id": traceId,
              ...machineSessionHeaders(sessionContext),
            },
            body: payload,
            signal: activeController.signal,
          }, requestTimeoutMs);
          clearTimeout(connectTimer);
          console.log(`[stream] id=${traceId} machine=${machine.id} headers=${response.status} attempt=${pool.indexOf(machine) + 1}`);
          if (response.ok) {
            registry.markHealthy(machine);
            if (!response.body) {
              registry.finishUsageRequest(requestId, null, "empty_response");
              lastError = new Error(`machine ${machine.id} returned an empty response body`);
              otherFailure = true;
              registry.markFailure(machine, lastError);
              continue;
            }
            const reader = response.body.getReader();
            let parserBuffer = "";
            let lastModelDataAt = Date.now();
            let machineSeenModelData = false;
            let machineDone = false;
            let usageRecorded = false;
            let observedUsage = null;
            let streamTimeout;
            let streamTimedOut = false;
            const timeoutError = () => {
              streamTimedOut = true;
              activeController?.abort(new Error(machineSeenModelData ? "upstream SSE idle timeout" : "upstream SSE first data timeout"));
              reader.cancel().catch(() => {});
            };
            streamTimeout = setInterval(() => {
              const limit = machineSeenModelData ? idleDataTimeoutMs : firstDataTimeoutMs;
              if (Date.now() - lastModelDataAt >= limit) timeoutError();
            }, Math.min(1_000, Math.max(100, Math.floor(Math.min(firstDataTimeoutMs, idleDataTimeoutMs) / 4))));
            streamTimeout.unref?.();
            try {
              while (!closed) {
                const next = await reader.read();
                if (next.done) break;
                if (next.value?.byteLength) {
                  const chunk = Buffer.from(next.value);
                  parserBuffer = `${parserBuffer}${chunk.toString("utf8")}`;
                  const blocks = parserBuffer.split(/\r?\n\r?\n/);
                  parserBuffer = blocks.pop() || "";
                  for (const block of blocks) {
                    const frame = classifySseBlock(block);
                    if (frame.error && !machineSeenModelData) {
                      lastError = new Error(`machine ${machine.id}: ${frame.error}`);
                      const rateLimitedFrame = frame.errorCode === 429 || frame.errorType === "rate_limit_error";
                      if (rateLimitedFrame) {
                        rateLimited = frame.error;
                        await registry.cooldown(machine);
                      } else {
                        otherFailure = true;
                      }
                    }
                    if (frame.usage && !usageRecorded) {
                      observedUsage = frame.usage;
                      usageRecorded = true;
                    }
                    if (frame.model) {
                      machineSeenModelData = true;
                      lastModelDataAt = Date.now();
                    }
                    if (frame.done) machineDone = true;

                    // The manager supplies its own heartbeat. Before the first
                    // real model frame, suppress machine heartbeats, errors,
                    // and [DONE] so a failed backend can be replaced without
                    // prematurely terminating the client's OpenAI stream.
                    if (!machineSeenModelData || frame.heartbeat || frame.internalUsage) continue;
                    if (!await writeChunk(Buffer.from(`${block}\n\n`))) break;
                  }
                }
              }
            } finally {
              clearInterval(streamTimeout);
              if (closed) await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
            const outcome = closed
              ? "client_closed"
              : streamTimedOut
                ? "timeout"
                : machineSeenModelData
                  ? "success"
                  : rateLimited
                    ? "rate_limited"
                    : machineDone
                      ? "no_model_data"
                      : "upstream_closed";
            console.log(
              `[stream] id=${traceId} machine=${machine.id} ended outcome=${outcome} `
              + `done=${machineDone} modelData=${machineSeenModelData} timedOut=${streamTimedOut} closed=${closed}`,
            );
            registry.finishUsageRequest(requestId, observedUsage, closed ? "client_closed" : streamTimedOut ? "timeout" : machineSeenModelData ? "success" : rateLimited ? "rate_limited" : "error");
            if (!machineSeenModelData && !closed) {
              lastError ||= new Error(streamTimedOut
                ? `machine ${machine.id} produced no model data before timeout`
                : `machine ${machine.id} closed without model data`);
              if (!rateLimited) otherFailure = true;
              if (rateLimited) registry.markFailure(machine, new Error(rateLimited));
              else registry.markFailure(machine, lastError);
              continue;
            }
            if (streamTimedOut && machineSeenModelData && !closed) {
              writeSse({ error: { message: "Upstream SSE idle timeout", type: "upstream_timeout" } });
            }
            if (machineSeenModelData && !closed) {
              registry.rememberSessionMachine?.(sessionContext.routingKey, machine);
            }
            upstreamDone = machineDone;
            return finish();
          }

          const text = await response.text();
          let details;
          try { details = text ? JSON.parse(text) : undefined; } catch { details = undefined; }
          const message = details?.error?.message || text || `${machine.id} returned ${response.status}`;
          if (response.status === 429) {
            registry.finishUsageRequest(requestId, null, "rate_limited");
            rateLimited = message;
            await registry.cooldown(machine);
            continue;
          }
          if (!retryableStatus(response.status)) {
            writeSse({ error: { message, type: response.status === 429 ? "rate_limit_error" : "upstream_error", code: response.status } });
            return finish();
          }
          lastError = new Error(message);
          registry.finishUsageRequest(requestId, null, `http_${response.status}`);
          otherFailure = true;
          registry.markFailure(machine, lastError);
        } catch (error) {
          clearTimeout(connectTimer);
          registry.finishUsageRequest(requestId, null, error?.name === "AbortError" ? "aborted" : "error");
          if (closed) return;
          lastError = error;
          otherFailure = true;
          registry.markFailure(machine, error);
        } finally {
          clearTimeout(connectTimer);
          activeController = null;
        }
      }
      if (!closed) {
        if (rateLimited && !otherFailure) {
          writeSse({ error: { message: rateLimited, type: "rate_limit_error", retry_after: Math.max(1, Math.ceil(registry.nextCooldownMs() / 1000)) } });
        } else {
          writeSse({ error: { message: lastError?.message || "All machines failed", type: "service_unavailable" } });
        }
      }
    } finally {
      finish();
    }
  }

  return { proxy };
}

module.exports = { completionProxy, rateLimitHeaders, retryableStatus };
