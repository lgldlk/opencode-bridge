"use strict";

const { Readable } = require("node:stream");
const { once } = require("node:events");
const { json, sseHeaders, sseHeartbeat } = require("../shared/http.ts");

function retryableStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

function rateLimitHeaders(registry) {
  const remainingMs = registry.nextCooldownMs();
  return remainingMs ? { "retry-after": String(Math.max(1, Math.ceil(remainingMs / 1000))) } : {};
}

function completionProxy({ registry, requestTimeoutMs }) {
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

  async function proxyStream(req, res, pool, payload, model) {
    res.writeHead(200, sseHeaders());
    res.flushHeaders?.();
    let closed = false;
    let activeController = null;
    let upstreamDone = false;
    const heartbeatFrame = sseHeartbeat("manager-keep-alive");
    // Send a full transport frame immediately, before waiting on the machine.
    // This is an SSE comment, so it never changes the model response.
    res.write(heartbeatFrame);
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(heartbeatFrame);
    }, 3_000);
    heartbeat.unref?.();
    const onClose = () => {
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
        try {
          const response = await registry.fetchMachine(machine, "/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: payload,
            signal: activeController.signal,
          }, requestTimeoutMs);
          console.log(`[stream] machine=${machine.id} headers=${response.status} after=${Date.now()}`);
          if (response.ok) {
            registry.markHealthy(machine);
            if (!response.body) return finish();
            const reader = response.body.getReader();
            try {
              let doneTail = "";
              while (!closed) {
                const next = await reader.read();
                if (next.done) break;
                if (next.value?.byteLength) {
                  const chunk = Buffer.from(next.value);
                  doneTail = `${doneTail}${chunk.toString("utf8")}`.slice(-32);
                  if (doneTail.includes("data: [DONE]")) upstreamDone = true;
                  if (!await writeChunk(chunk)) break;
                }
              }
            } finally {
              if (closed) await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
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
          if (closed) return;
          lastError = error;
          otherFailure = true;
          registry.markFailure(machine, error);
        } finally {
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
