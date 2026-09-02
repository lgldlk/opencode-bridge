"use strict";

/**
 * A deliberately boring MCP stdio server.
 *
 * OpenCode owns the agent loop, but the caller owns tool execution. This
 * process only publishes the caller's JSON Schemas to OpenCode; chat.ts
 * intercepts the resulting tool part on the event stream and aborts the
 * session before this no-op `tools/call` handler can run. It never reads,
 * writes, or executes anything in the remote workspace.
 */
const { Buffer } = require("node:buffer");
import type { JsonObject } from "../shared/types.ts";

interface McpToolDefinition {
  name?: string;
  description?: string;
  parameters?: JsonObject;
}
interface StdioOptions {
  input?: NodeJS.ReadableStream & { setEncoding(encoding: BufferEncoding): void };
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  onEnd?: () => void;
  maxFrameBytes?: number;
}
type JsonRpcId = string | number | null;
interface JsonRpcMessage extends JsonObject {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: JsonObject;
}

function parseTools(value: string | undefined, onError?: (error: unknown) => void): McpToolDefinition[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    onError?.(error);
  }
  return [];
}

function response(id: JsonRpcId | undefined, result: JsonObject): JsonObject | null {
  return id === undefined || id === null ? null : { jsonrpc: "2.0", id, result };
}

function errorResponse(id: JsonRpcId | undefined, code: number, message: string): JsonObject | null {
  return id === undefined || id === null
    ? null
    : { jsonrpc: "2.0", id, error: { code, message } };
}

function dispatch(message: unknown, tools: McpToolDefinition[] = []): JsonObject | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const source = message as JsonRpcMessage;
  const { id, method, params } = source;
  if (source.jsonrpc !== "2.0" || typeof method !== "string") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  switch (method) {
    case "initialize":
      return response(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opencode-bridge-tool-proxy", version: "1.0.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return response(id, {});
    case "tools/list":
      return response(id, {
        tools: tools.map((tool) => ({
          name: tool?.name,
          description: tool?.description ?? "",
          inputSchema: tool?.parameters ?? { type: "object", properties: {} },
        })),
      });
    case "tools/call":
      // Tool execution belongs to the caller's local runtime. Returning a
      // successful natural-language result here would pollute the OpenCode
      // session and make the model believe the remote machine executed it.
      return errorResponse(id, -32001, "Tool execution is delegated to the client");
    default:
      return errorResponse(id, -32601, `Method not found: ${method}`);
  }
}

function runStdioServer(tools: McpToolDefinition[], options: StdioOptions = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const onEnd = options.onEnd ?? (() => process.exit(0));
  const configuredMax = Number(options.maxFrameBytes ?? process.env.OPENCODE_BRIDGE_MAX_FRAME_BYTES);
  const maxFrameBytes = Number.isSafeInteger(configuredMax) && configuredMax > 0
    ? configuredMax
    : 1024 * 1024;

  const send = (message: JsonObject) => output.write(`${JSON.stringify(message)}\n`);
  const sendError = (code: number, message: string) => send({ jsonrpc: "2.0", id: null, error: { code, message } });
  const processFrame = (frame: string) => {
    const line = frame.trim();
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      sendError(-32700, "Parse error");
      errorOutput.write(`opencode-bridge MCP: failed to parse message: ${error}\n`);
      return;
    }
    const result = dispatch(message, tools);
    if (result) send(result);
  };

  let buffer = "";
  let bufferBytes = 0;
  let oversized = false;
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    let start = 0;
    for (let newlineIndex; (newlineIndex = chunk.indexOf("\n", start)) !== -1; start = newlineIndex + 1) {
      const part = chunk.slice(start, newlineIndex);
      if (!oversized) {
        const partBytes = Buffer.byteLength(part);
        if (bufferBytes + partBytes > maxFrameBytes) {
          oversized = true;
          buffer = "";
          bufferBytes = 0;
          sendError(-32600, "Invalid Request");
        } else {
          processFrame(buffer + part);
        }
      }
      buffer = "";
      bufferBytes = 0;
      oversized = false;
    }
    const part = chunk.slice(start);
    if (!oversized) {
      const partBytes = Buffer.byteLength(part);
      if (bufferBytes + partBytes > maxFrameBytes) {
        oversized = true;
        buffer = "";
        bufferBytes = 0;
        sendError(-32600, "Invalid Request");
      } else {
        buffer += part;
        bufferBytes += partBytes;
      }
    }
  });
  input.on("end", () => {
    if (!oversized) processFrame(buffer);
    onEnd();
  });
}

const tools = parseTools(process.env.OPENCODE_BRIDGE_TOOLS, (error) => {
  process.stderr.write(`opencode-bridge MCP: failed to parse tool schemas: ${error}\n`);
});

if (require.main === module) runStdioServer(tools);

module.exports = { dispatch, parseTools, runStdioServer };
