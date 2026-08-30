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

function parseTools(value, onError) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    onError?.(error);
  }
  return [];
}

function response(id, result) {
  return id === undefined || id === null ? null : { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return id === undefined || id === null
    ? null
    : { jsonrpc: "2.0", id, error: { code, message } };
}

function dispatch(message, tools = []) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const { id, method, params } = message;
  if (message.jsonrpc !== "2.0" || typeof method !== "string") {
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
      return response(id, {
        content: [{ type: "text", text: "Tool call intercepted by opencode-bridge." }],
      });
    default:
      return errorResponse(id, -32601, `Method not found: ${method}`);
  }
}

function runStdioServer(tools, options: any = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const onEnd = options.onEnd ?? (() => process.exit(0));
  const configuredMax = Number(options.maxFrameBytes ?? process.env.OPENCODE_BRIDGE_MAX_FRAME_BYTES);
  const maxFrameBytes = Number.isSafeInteger(configuredMax) && configuredMax > 0
    ? configuredMax
    : 1024 * 1024;

  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const sendError = (code, message) => send({ jsonrpc: "2.0", id: null, error: { code, message } });
  const processFrame = (frame) => {
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
  input.on("data", (chunk) => {
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
