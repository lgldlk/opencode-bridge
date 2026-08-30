"use strict";

const { Readable } = require("node:stream");
const { once } = require("node:events");
const { json, sseHeaders, sseDataHeartbeat, SSE_HEARTBEAT_INTERVAL_MS } = require("../shared/http.ts");

function retryableStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

function rateLimitHeaders(registry) {
  const remainingMs = registry.nextCooldownMs();
  return remainingMs ? { "retry-after": String(Math.max(1, Math.ceil(remainingMs / 1000))) } : {};
}

function completionProxy({ registry, requestTimeoutMs, upstreamConnectTimeoutMs = 12_000, firstDataTimeoutMs = 900_000, idleDataTimeoutMs = firstDataTimeoutMs }) {
  async function proxy(req, res, body) {
    const model = body.model;
    const pool = registry.candidates(model);
    console.log(`[request] stream=${body.stream === true} model=${model || "<default>"} bytes=${req.headers["content-length"] || "?"} remote=${req.socket.remoteAddress || "?"}`);
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
      ? proxyStream(req, res, pool, payload, model)
      : proxyJson(res, pool, payload);
  }

  async function proxyJson(res, pool, payload) {
    let lastError;
    let rateLimited = null;
    let otherFailure = false;
    for (const machine of pool) {
      try {
        const response = await registry.fetchMachine(machine, "/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        });
        if (response.ok) {
          registry.markHealthy(machine);
          res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json" });
          if (response.body) return Readable.fromWeb(response.body).pipe(res);
          return res.end();
        }
        if (response.status === 429) {
          const text = await response.text();
          let details;
          try { details = text ? JSON.parse(text) : undefined; } catch { details = undefined; }
          rateLimited = details?.error?.message || text || `${machine.id} is rate limited`;
          await registry.cooldown(machine);
          continue;
        }
        if (!retryableStatus(response.status)) {
          res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json" });
          return res.end(await response.text());
        }
        await response.body?.cancel();
        lastError = new Error(`${machine.id} returned ${response.status}`);
        otherFailure = true;
        registry.markFailure(machine, lastError);
      } catch (error) {
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

  function classifySseBlock(block) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return { model: false, done: false, heartbeat: false };
    if (data === "[DONE]") return { model: false, done: true, heartbeat: false };
    try {
      const value = JSON.parse(data);
      const heartbeat = typeof value?.id === "string" && value.id.startsWith("sse-");
      const model = !heartbeat && Array.isArray(value?.choices) && value.choices.some((choice) => {
        if (choice?.finish_reason) return true;
        const delta = choice?.delta || {};
        return (typeof delta.content === "string" && delta.content.length > 0)
          || (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0)
          || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
          || (delta.function_call && typeof delta.function_call === "object"
            && Object.keys(delta.function_call).length > 0);
      });
      return {
        model,
        done: false,
        heartbeat,
        error: value?.error?.message ? String(value.error.message) : undefined,
      };
    } catch {
      return { model: false, done: false, heartbeat: false };
    }
  }

  async function proxyStream(req, res, pool, payload, model) {
    res.writeHead(200, sseHeaders());
    res.flushHeaders?.();
    let closed = false;
    let activeController = null;
    let upstreamDone = false;
    const heartbeatFrame = sseDataHeartbeat("manager-keep-alive");
    // Use a valid empty OpenAI chunk: some proxies buffer SSE comments and
    // leave the client waiting even though the TCP connection is alive.
    res.write(heartbeatFrame);
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(heartbeatFrame);
    }, SSE_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    const onClose = () => {
      if (!closed) console.log(`[stream] client-closed model=${model || "<default>"}`);
      closed = true;
      activeController?.abort();
      clearInterval(heartbeat);
    };
    req.once("aborted", onClose);
    res.once("close", onClose);
    const writeSse = (value) => {
      if (!closed && !res.writableEnded) res.write(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
    };
    const writeChunk = async (chunk) => {
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

    console.log(`[stream] headers-sent model=${model || "<default>"} machines=${pool.map((item) => item.id).join(",")}`);
    let lastError;
    let rateLimited = null;
    let otherFailure = false;
    try {
      for (const machine of pool) {
        if (closed) return;
        activeController = new AbortController();
        const connectTimer = setTimeout(() => activeController?.abort(new Error("upstream response headers timed out")), upstreamConnectTimeoutMs);
        connectTimer.unref?.();
        try {
          const response = await registry.fetchMachine(machine, "/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: payload,
            signal: activeController.signal,
          }, requestTimeoutMs);
          clearTimeout(connectTimer);
          console.log(`[stream] machine=${machine.id} headers=${response.status} after=${Date.now()}`);
          if (response.ok) {
            registry.markHealthy(machine);
            if (!response.body) {
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
                    if (!machineSeenModelData || frame.heartbeat) continue;
                    if (!await writeChunk(Buffer.from(`${block}\n\n`))) break;
                  }
                }
              }
            } finally {
              clearInterval(streamTimeout);
              if (closed) await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
            console.log(`[stream] machine=${machine.id} ended done=${machineDone} modelData=${machineSeenModelData} timedOut=${streamTimedOut} closed=${closed}`);
            if (!machineSeenModelData && !closed) {
              lastError ||= new Error(streamTimedOut
                ? `machine ${machine.id} produced no model data before timeout`
                : `machine ${machine.id} closed without model data`);
              otherFailure = true;
              registry.markFailure(machine, lastError);
              continue;
            }
            if (streamTimedOut && machineSeenModelData && !closed) {
              writeSse({ error: { message: "Upstream SSE idle timeout", type: "upstream_timeout" } });
            }
            upstreamDone = machineDone;
            return finish();
          }

          const text = await response.text();
          let details;
          try { details = text ? JSON.parse(text) : undefined; } catch { details = undefined; }
          const message = details?.error?.message || text || `${machine.id} returned ${response.status}`;
          if (response.status === 429) {
            rateLimited = message;
            await registry.cooldown(machine);
            continue;
          }
          if (!retryableStatus(response.status)) {
            writeSse({ error: { message, type: response.status === 429 ? "rate_limit_error" : "upstream_error", code: response.status } });
            return finish();
          }
          lastError = new Error(message);
          otherFailure = true;
          registry.markFailure(machine, lastError);
        } catch (error) {
          clearTimeout(connectTimer);
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
