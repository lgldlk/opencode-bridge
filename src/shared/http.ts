"use strict";

import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_MAX_BODY = 16 * 1024 * 1024;
const SSE_HEARTBEAT_MIN_BYTES = 2 * 1024;
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export interface HttpError extends Error { status?: number; data?: unknown; }

function httpError(message: string, status: number, data: unknown = undefined): HttpError {
  return Object.assign(new Error(message), { status, data });
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function readJsonBody(req: IncomingMessage, maxBody = DEFAULT_MAX_BODY): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      size += chunk.length;
      if (size > maxBody) {
        reject(httpError("request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
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

// SSE comments are ignored by OpenAI-compatible clients. Pad them above the
// common intermediary buffering threshold so the live connection still flushes
// without fabricating a chat.completion chunk.
function sseHeartbeat(name: string, padded = true): string {
  const prefix = `: ${name}`;
  const padding = padded
    ? " ".repeat(Math.max(0, SSE_HEARTBEAT_MIN_BYTES - Buffer.byteLength(prefix) - 2))
    : "";
  return `${prefix}${padding}\n\n`;
}

module.exports = { DEFAULT_MAX_BODY, SSE_HEARTBEAT_INTERVAL_MS, httpError, json, readJsonBody, sseHeaders, sseHeartbeat };
