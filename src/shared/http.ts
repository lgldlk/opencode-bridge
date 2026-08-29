"use strict";

const DEFAULT_MAX_BODY = 16 * 1024 * 1024;
const SSE_HEARTBEAT_MIN_BYTES = 2 * 1024;

function httpError(message, status, data = undefined) {
  return Object.assign(new Error(message), { status, data });
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function readJsonBody(req, maxBody = DEFAULT_MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBody) {
        reject(httpError("request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError("invalid JSON body", 400));
      }
    });
    req.on("error", reject);
  });
}

function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-encoding": "identity",
    "x-accel-buffering": "no",
  };
}

// SSE comments are ignored by OpenAI-compatible clients. Pad them so a proxy
// that buffers small chunks still flushes a live response to the client.
function sseHeartbeat(name) {
  const prefix = `: ${name}`;
  return `${prefix}${" ".repeat(Math.max(0, SSE_HEARTBEAT_MIN_BYTES - Buffer.byteLength(prefix) - 2))}\n\n`;
}

module.exports = { DEFAULT_MAX_BODY, httpError, json, readJsonBody, sseHeaders, sseHeartbeat };
