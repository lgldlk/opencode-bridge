const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BRIDGE_KEY = "test-bridge-key";
process.env.OPENCODE_PASSWORD = "test-opencode-password";
const { selectModel } = require("../src/machine.ts");

test("machine delegates omitted model to OpenCode catalog default", () => {
  const catalog = {
    default: { anthropic: "claude-sonnet" },
    all: [
      { id: "openai", models: { "gpt-4o": {} } },
      { id: "anthropic", models: { "claude-sonnet": {} } },
    ],
  };
  assert.deepEqual(selectModel(catalog, ""), {
    name: "anthropic/claude-sonnet",
    ref: { providerID: "anthropic", modelID: "claude-sonnet" },
  });
});

test("machine supports explicit provider/model selection", () => {
  const catalog = { all: [{ id: "openai", models: { "gpt-4o": {} } }] };
  assert.deepEqual(selectModel(catalog, "openai/gpt-4o"), {
    name: "openai/gpt-4o",
    ref: { providerID: "openai", modelID: "gpt-4o" },
  });
});

test("machine does not load the provider catalog for an explicit model", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let providerCalls = 0;
  const chat = createChatHandler({
    client: { providers: async () => { providerCalls += 1; return { all: [] }; } },
    directory: "/tmp",
    defaultModel: "",
  });
  assert.deepEqual(await chat.resolveModel("opencode/muse-spark-1.2-contributor-free"), {
    name: "opencode/muse-spark-1.2-contributor-free",
    ref: { providerID: "opencode", modelID: "muse-spark-1.2-contributor-free" },
  });
  assert.equal(providerCalls, 0);
});

test("machine disables every remote tool when the client did not offer tools", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  const chat = createChatHandler({
    client: { toolIds: async () => ["bash", "read", "custom-tool"] },
    directory: "/tmp",
    defaultModel: "",
  });
  assert.deepEqual(await chat.disabledTools(), {
    bash: false,
    read: false,
    "custom-tool": false,
    "default.bash": false,
    "default.read": false,
    "default.custom-tool": false,
  });
});

test("machine maps OpenAI client tools to OpenCode tool names", () => {
  const {
    clientToolDefinitions,
    clientToolMap,
  } = require("../src/machine/chat.ts");
  const definitions = clientToolDefinitions([
    { type: "function", function: { name: "read", parameters: { type: "object" } } },
    { type: "function", function: { name: "find", parameters: { type: "object" } } },
  ]);
  const toolMap = clientToolMap(definitions, ["bash", "read", "glob"]);
  assert.deepEqual([...toolMap], [["read", "read"], ["glob", "find"]]);
});

test("machine honors OpenAI tool_choice without inspecting user text", () => {
  const { applyToolChoice, clientToolDefinitions } = require("../src/machine/chat.ts");
  const definitions = clientToolDefinitions([
    { type: "function", function: { name: "read", parameters: { type: "object" } } },
    { type: "function", function: { name: "write", parameters: { type: "object" } } },
  ]);
  assert.deepEqual([...applyToolChoice(definitions, "none").keys()], []);
  assert.deepEqual(
    [...applyToolChoice(definitions, { type: "function", function: { name: "write" } }).keys()],
    ["write"],
  );
  assert.deepEqual([...applyToolChoice(definitions, "auto").keys()], ["read", "write"]);
});

test("machine validates required client tool arguments before returning them", () => {
  const { validateClientToolArguments } = require("../src/machine/chat.ts");
  const definition = {
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  };
  assert.equal(validateClientToolArguments("bash", {}, definition).ok, false);
  assert.equal(validateClientToolArguments("bash", { command: "pwd" }, definition).ok, true);
});

test("machine does not guess a filesystem root from a tool name", () => {
  const { validateClientToolArguments } = require("../src/machine/chat.ts");
  const result = validateClientToolArguments("write", {
    path: "/private/workspace/tool-output/admin.html",
    content: "test",
  }, {
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
  });
  assert.equal(result.ok, true);
});

test("canonical prompt keeps tool history structured without natural-language labels", () => {
  const { renderOpenCodePrompt } = require("../src/machine/canonical-messages.ts");
  const result = renderOpenCodePrompt({
    messages: [
      { role: "user", content: "Read the file." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: "{\"path\":\"README.md\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call-1", name: "read", content: "file contents" },
    ],
  });
  assert.doesNotMatch(result.text, /Continue the canonical conversation/);
  assert.doesNotMatch(result.text, /Requested tool read/);
  assert.doesNotMatch(result.text, /Tool read returned/);
  assert.match(result.text, /"role":"assistant"/);
  assert.match(result.text, /"type":"tool_call"/);
  assert.match(result.text, /"type":"tool_result"/);
  assert.equal(result.system, "");
});

test("machine converts OpenCode tool inputs to Pi-compatible local arguments", () => {
  const { mapToolInput } = require("../src/machine/chat.ts");
  const readDefinition = {
    parameters: { properties: { path: {}, offset: {}, limit: {} } },
  };
  assert.deepEqual(
    mapToolInput("read", "read", { filePath: "/workspace/a.ts", offset: 3, limit: 5, ignored: true }, readDefinition),
    { path: "/workspace/a.ts", offset: 3, limit: 5 },
  );
  const editDefinition = {
    parameters: { properties: { path: {}, edits: {} } },
  };
  assert.deepEqual(
    mapToolInput("edit", "edit", { filePath: "a.ts", oldString: "old", newString: "new" }, editDefinition),
    { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
  );
});

test("machine emits standard OpenAI tool_calls for Pi to execute locally", () => {
  const { sessionPermission, toolCompletion } = require("../src/machine/chat.ts");
  assert.deepEqual(sessionPermission(new Map([["read", "read"]])), [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "ask" },
  ]);
  const result = toolCompletion("request", "provider/model", {
    id: "call-1",
    name: "read",
    arguments: { path: "README.md" },
  });
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(result.choices[0].message.tool_calls[0], {
    id: "call-1",
    type: "function",
    function: { name: "read", arguments: '{"path":"README.md"}' },
  });
});

test("machine refuses client tools when the MCP bridge is unavailable", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let sessionCreated = false;
  const client = {
    toolIds: async () => ["bash", "read"],
    async request(requestPath) {
      if (requestPath.startsWith("/session?")) sessionCreated = true;
      throw new Error(`unexpected OpenCode request ${requestPath}`);
    },
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    end(chunk = "") {
      this.body += String(chunk);
      this.writableEnded = true;
    },
  };
  const chat = createChatHandler({
    client,
    directory: "/remote-worker",
    defaultModel: "",
  });

  await chat.handle({}, response, {
    model: "opencode/test",
    messages: [{ role: "user", content: "Read README.md" }],
    tools: [{
      type: "function",
      function: {
        name: "read",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, limit: { type: "number" } },
        },
      },
    }],
  });

  assert.equal(sessionCreated, false);
  assert.equal(response.statusCode, 503);
  const result = JSON.parse(response.body);
  assert.equal(result.error.type, "client_tool_bridge_unavailable");
});

test("machine uses an MCP schema bridge when the OpenCode client supports MCP", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let emitEvent;
  let promptPayload;
  let addedConfig;
  let disconnected = "";
  const client = {
    toolIds: async () => ["read"],
    async mcpAdd(name, config) {
      addedConfig = { name, config };
      return {};
    },
    async mcpDisconnect(name) {
      disconnected = name;
      return {};
    },
    subscribeEvents(signal, callback) {
      emitEvent = callback;
      return {
        ready: Promise.resolve(),
        done: new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      };
    },
    async request(requestPath, options = {}) {
      if (requestPath.startsWith("/session?")) return { id: "session-mcp" };
      if (requestPath.includes("/message?")) {
        promptPayload = JSON.parse(options.body);
        queueMicrotask(() => emitEvent({
          type: "message.part.updated",
          properties: {
            sessionID: "session-mcp",
            part: {
              type: "tool",
              tool: `${addedConfig.name}_read`,
              callID: "mcp-call-1",
              state: { status: "running", input: { path: "web/admin.html" } },
            },
          },
        }));
        return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
      }
      throw new Error(`unexpected request ${requestPath}`);
    },
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body += String(chunk); },
    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; },
  };
  const chat = createChatHandler({ client, directory: "/home/remote", defaultModel: "" });
  await chat.handle({}, response, {
    model: "opencode/test",
    messages: [{ role: "user", content: "read the admin page" }],
    tools: [{
      type: "function",
      function: {
        name: "read",
        description: "Read a local file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
  });
  assert.equal(addedConfig.config.type, "local");
  assert.deepEqual(promptPayload.tools[`${addedConfig.name}_read`], true);
  assert.equal(promptPayload.system, undefined);
  assert.equal(disconnected, addedConfig.name);
  const result = JSON.parse(response.body);
  assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { path: "web/admin.html" });
});

test("machine returns edit arguments for the local client without remote path rewriting", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let emitEvent;
  let bridgeName = "";
  let promptPayload;
  const client = {
    toolIds: async () => ["edit"],
    async mcpAdd(name) { bridgeName = name; },
    async mcpConnect() {},
    async mcpDisconnect() {},
    subscribeEvents(signal, callback) {
      emitEvent = callback;
      return {
        ready: Promise.resolve(),
        done: new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      };
    },
    async request(requestPath, options = {}) {
      if (requestPath.startsWith("/session?")) return { id: "session-edit" };
      if (requestPath.includes("/message?")) {
        promptPayload = JSON.parse(options.body);
        queueMicrotask(() => emitEvent({
          type: "message.part.updated",
          properties: {
            sessionID: "session-edit",
            part: {
              type: "tool",
              tool: `${bridgeName}_edit`,
              callID: "edit-call",
              state: {
                status: "running",
                input: {
                  path: "/workspace/project/src/app.ts",
                  oldText: "before",
                  newText: "after",
                },
              },
            },
          },
        }));
        return new Promise((resolve, reject) => options.signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted after edit capture"), { name: "AbortError" })),
          { once: true },
        ));
      }
      throw new Error(`unexpected OpenCode request ${requestPath}`);
    },
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write() {},
    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; },
  };
  const chat = createChatHandler({ client, directory: "/remote", defaultModel: "" });
  await chat.handle({}, response, {
    model: "opencode/test",
    messages: [{ role: "user", content: "Edit the local file." }],
    tools: [{
      type: "function",
      function: {
        name: "edit",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            oldText: { type: "string" },
            newText: { type: "string" },
          },
          required: ["path", "oldText", "newText"],
        },
      },
    }],
  });

  assert.equal(promptPayload.tools[`${bridgeName}_edit`], true);
  const result = JSON.parse(response.body);
  assert.deepEqual(
    JSON.parse(result.choices[0].message.tool_calls[0].function.arguments),
    { path: "/workspace/project/src/app.ts", oldText: "before", newText: "after" },
  );
});

test("machine fails closed instead of executing client edit remotely when MCP setup fails", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let sessionCreated = false;
  const client = {
    toolIds: async () => ["edit", "read", "write"],
    async mcpAdd() {
      throw new Error("MCP registration failed");
    },
    async mcpDisconnect() {},
    async request(requestPath) {
      if (requestPath.startsWith("/session?")) sessionCreated = true;
      throw new Error(`unexpected OpenCode request ${requestPath}`);
    },
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write() {},
    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; },
  };
  const chat = createChatHandler({ client, directory: "/remote", defaultModel: "" });

  await chat.handle({}, response, {
    model: "opencode/test",
    messages: [{ role: "user", content: "Edit the local file." }],
    tools: [{
      type: "function",
      function: {
        name: "edit",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, edits: { type: "array" } },
          required: ["path", "edits"],
        },
      },
    }],
  });

  assert.equal(response.statusCode, 503);
  assert.equal(sessionCreated, false);
  const result = JSON.parse(response.body);
  assert.equal(result.error.type, "client_tool_bridge_unavailable");
});

test("machine settles session.idle long enough to capture a late MCP tool event", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let emitEvent;
  let bridgeName;
  let messagesCalls = 0;
  const client = {
    toolIds: async () => ["read"],
    async mcpAdd(name) {
      bridgeName = name;
      return {};
    },
    async mcpDisconnect() {
      return {};
    },
    subscribeEvents(signal, callback) {
      emitEvent = callback;
      return {
        ready: Promise.resolve(),
        done: new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      };
    },
    async request(requestPath) {
      if (requestPath.startsWith("/session?")) return { id: "session-idle-race" };
      if (requestPath.includes("/abort?") || requestPath.includes("/session-idle-race?")) return {};
      throw new Error(`unexpected request ${requestPath}`);
    },
    async promptAsync() {
      emitEvent({
        type: "session.idle",
        properties: { sessionID: "session-idle-race" },
      });
      setTimeout(() => {
        emitEvent({
          type: "message.part.updated",
          properties: {
            sessionID: "session-idle-race",
            part: {
              type: "tool",
              messageID: "msg-idle-race",
              tool: `${bridgeName}_read`,
              callID: "call-idle-race",
              state: { status: "running", input: { path: "web/admin.html" } },
            },
          },
        });
        emitEvent({
          type: "message.part.updated",
          properties: {
            sessionID: "session-idle-race",
            part: { type: "step-finish", messageID: "msg-idle-race" },
          },
        });
      }, 100);
    },
    async sessionMessages() {
      messagesCalls += 1;
      return [];
    },
    async sessionAbort() {},
    async sessionDelete() {},
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body += String(chunk); },
    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; },
  };
  const chat = createChatHandler({
    client,
    directory: "/remote",
    defaultModel: "",
  });

  await chat.handle({}, response, {
    model: "opencode/test",
    messages: [{ role: "user", content: "Read the file." }],
    tools: [{
      type: "function",
      function: {
        name: "read",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    }],
  });

  const result = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(
    JSON.parse(result.choices[0].message.tool_calls[0].function.arguments),
    { path: "web/admin.html" },
  );
  assert.ok(messagesCalls >= 1);
});

test("machine waits for the final OpenCode tool snapshot instead of inferring arguments from user text", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let emitEvent;
  let bridgeName = "";
  const finalPath = "/client/workspace/web/admin.html";
  const client = {
    toolIds: async () => ["read"],
    async mcpAdd(name) { bridgeName = name; },
    async mcpConnect() {},
    async mcpDisconnect() {},
    subscribeEvents(signal, callback) {
      emitEvent = callback;
      return {
        ready: Promise.resolve(),
        done: new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      };
    },
    async request(path) {
      if (path.startsWith("/session?")) return { id: "session-final-tool" };
      throw new Error(`unexpected request ${path}`);
    },
    async promptAsync(sessionId) {
      queueMicrotask(() => {
        emitEvent({
          type: "message.part.updated",
          properties: {
            sessionID: sessionId,
            part: {
              type: "tool",
              tool: `${bridgeName}_read`,
              callID: "call-final",
              state: { status: "pending", input: {}, raw: `{"path":"${finalPath}"}` },
            },
          },
        });
        emitEvent({
          type: "message.part.updated",
          properties: {
            sessionID: sessionId,
            part: { type: "step-finish", messageID: "assistant-final" },
          },
        });
      });
    },
    async sessionMessages() {
      return { data: [{
        info: { role: "assistant" },
        parts: [{
          type: "tool",
          tool: `${bridgeName}_read`,
          callID: "call-final",
          state: { status: "running", input: { path: finalPath } },
        }],
      }] };
    },
    async sessionAbort() {},
    async sessionDelete() {},
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; },
  };
  const chat = createChatHandler({ client, directory: "/remote", defaultModel: "" });
  await chat.handle({}, response, {
    model: "opencode/test",
    messages: [{ role: "user", content: "请读取我指定的文件" }],
    tools: [{
      type: "function",
      function: {
        name: "read",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
  });
  const result = JSON.parse(response.body);
  assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { path: finalPath });
});

test("machine recovers a tool call when SSE omitted the tool part", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let emitEvent;
  let bridgeName = "";
  const client = {
    toolIds: async () => ["read"],
    async mcpAdd(name) { bridgeName = name; },
    async mcpConnect() {},
    async mcpDisconnect() {},
    subscribeEvents(signal, callback) {
      emitEvent = callback;
      return {
        ready: Promise.resolve(),
        done: new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      };
    },
    async request(path) {
      if (path.startsWith("/session?")) return { id: "session-hydrated-only" };
      throw new Error(`unexpected request ${path}`);
    },
    async promptAsync(sessionId) {
      queueMicrotask(() => emitEvent({
        type: "message.part.updated",
        properties: {
          sessionID: sessionId,
          part: { type: "step-finish", messageID: "assistant-hydrated" },
        },
      }));
    },
    async sessionMessages() {
      return {
        data: [{
          info: { role: "assistant" },
          parts: [{
            type: "tool",
            tool: `${bridgeName}_read`,
            callID: "call-hydrated",
            state: { status: "completed", input: { path: "README.md" } },
          }],
        }],
      };
    },
    async sessionAbort() {},
    async sessionDelete() {},
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; },
  };
  const chat = createChatHandler({ client, directory: "/remote", defaultModel: "" });
  await chat.handle({}, response, {
    model: "opencode/test",
    messages: [{ role: "user", content: "读取 README.md" }],
    tools: [{
      type: "function",
      function: {
        name: "read",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
  });
  const result = JSON.parse(response.body);
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { path: "README.md" });
});

test("machine buffers preamble text so streaming clients receive a clean tool-call turn", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let emitEvent;
  let bridgeName = "";
  const client = {
    toolIds: async () => ["read"],
    async mcpAdd(name) { bridgeName = name; },
    async mcpConnect() {},
    async mcpDisconnect() {},
    subscribeEvents(signal, callback) {
      emitEvent = callback;
      return {
        ready: Promise.resolve(),
        done: new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      };
    },
    async request(path) {
      if (path.startsWith("/session?")) return { id: "session-buffered-tool" };
      throw new Error(`unexpected request ${path}`);
    },
    async promptAsync(sessionId) {
      queueMicrotask(() => {
        emitEvent({ type: "message.updated", properties: { sessionID: sessionId, info: { id: "assistant-buffered", role: "assistant" } } });
        emitEvent({ type: "message.part.delta", properties: { sessionID: sessionId, messageID: "assistant-buffered", field: "text", delta: "收到，正在读取该文件。" } });
        emitEvent({
          type: "message.part.updated",
          properties: {
            sessionID: sessionId,
            part: { type: "tool", tool: `${bridgeName}_read`, callID: "call-buffered", state: { status: "running", input: { path: "web/admin.html" } } },
          },
        });
        emitEvent({
          type: "message.part.updated",
          properties: { sessionID: sessionId, part: { type: "step-finish", messageID: "assistant-buffered" } },
        });
      });
    },
    async sessionMessages() {
      return { data: [{ info: { role: "assistant" }, parts: [] }] };
    },
    async sessionAbort() {},
    async sessionDelete() {},
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; },
  };
  const chat = createChatHandler({ client, directory: "/remote", defaultModel: "" });
  await chat.handle({}, response, {
    model: "opencode/test",
    stream: true,
    messages: [{ role: "user", content: "读取 admin 页面" }],
    tools: [{
      type: "function",
      function: {
        name: "read",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
  });
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /收到，正在读取/);
  assert.match(response.body, /"finish_reason":"tool_calls"/);
  assert.match(response.body, /"name":"read"/);
});

test("machine subscribes to the directory-scoped OpenCode event stream", async (t) => {
  const { createOpenCodeClient } = require("../src/machine/opencode-client.ts");
  const originalFetch = global.fetch;
  let requestedUrl = "";
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response('data: {"type":"server.connected","properties":{}}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const client = createOpenCodeClient({
    url: "http://loopback.invalid",
    username: "opencode",
    password: "test",
    directory: "/workspace/a b",
    requestTimeoutMs: 1_000,
  });
  const controller = new AbortController();
  const events = [];
  const stream = client.subscribeEvents(controller.signal, (event) => events.push(event));
  await stream.ready;
  await stream.done;
  assert.equal(requestedUrl, "http://loopback.invalid/event?directory=%2Fworkspace%2Fa%20b");
  assert.equal(events[0].type, "server.connected");
});

test("machine prefers OpenCode prompt_async and completes from the event lifecycle", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let emitEvent;
  let promptCalls = 0;
  let syncCalls = 0;
  const client = {
    toolIds: async () => ["read"],
    subscribeEvents(signal, callback) {
      emitEvent = callback;
      return {
        ready: Promise.resolve(),
        done: new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      };
    },
    async request(path, options = {}) {
      if (path.startsWith("/session?")) return { id: "async-session" };
      if (path.includes("/message?") && options.method === "POST") {
        syncCalls += 1;
        throw new Error("synchronous endpoint should not be used");
      }
      throw new Error(`unexpected request ${path}`);
    },
    async promptAsync(sessionId, payload) {
      promptCalls += 1;
      assert.equal(sessionId, "async-session");
      assert.equal(payload.parts[0].type, "text");
      assert.equal(payload.agent, "build");
      queueMicrotask(() => {
        emitEvent({ type: "message.part.delta", properties: { sessionID: sessionId, messageID: "user-echo", field: "text", delta: "{\"role\":\"user\",\"content\":\"echo\"}" } });
        emitEvent({ type: "message.updated", properties: { sessionID: sessionId, info: { id: "user-echo", role: "user" } } });
        emitEvent({ type: "message.updated", properties: { sessionID: sessionId, info: { id: "assistant-1", role: "assistant", tokens: { input: 2, output: 3 } } } });
        emitEvent({ type: "message.part.delta", properties: { sessionID: sessionId, messageID: "assistant-1", partID: "text-1", field: "text", delta: "async ok" } });
        emitEvent({ type: "session.idle", properties: { sessionID: sessionId } });
      });
      return {};
    },
    async sessionMessages() {
      return { data: [{ info: { role: "assistant", tokens: { input: 2, output: 3 } }, parts: [{ type: "text", text: "async ok" }] }] };
    },
    async sessionAbort() {},
    async sessionDelete() {},
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; },
  };
  const chat = createChatHandler({ client, directory: "/remote", defaultModel: "", firstDataTimeoutMs: 1_000 });
  await chat.handle({}, response, {
    model: "opencode/test",
    messages: [{ role: "user", content: "long task" }],
  });
  assert.equal(promptCalls, 1);
  assert.equal(syncCalls, 0);
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /"role":"user"/);
  assert.equal(JSON.parse(response.body).choices[0].message.content, "async ok");
  assert.deepEqual(JSON.parse(response.body).usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
});

test("machine does not forward message.part.delta frames without a message id before hydrating the assistant snapshot", async () => {
  const { createChatHandler } = require("../src/machine/chat.ts");
  let emitEvent;
  const client = {
    toolIds: async () => [],
    subscribeEvents(signal, callback) {
      emitEvent = callback;
      return {
        ready: Promise.resolve(),
        done: new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      };
    },
    async request(path) {
      if (path.startsWith("/session?")) return { id: "session-no-message-id" };
      throw new Error(`unexpected request ${path}`);
    },
    async promptAsync(sessionId) {
      queueMicrotask(() => {
        emitEvent({
          type: "message.part.delta",
          properties: { sessionID: sessionId, field: "text", delta: "snapshot answer" },
        });
        emitEvent({ type: "session.idle", properties: { sessionID: sessionId } });
      });
    },
    async sessionMessages() {
      return { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "snapshot answer" }] }] };
    },
    async sessionAbort() {},
    async sessionDelete() {},
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(chunk) { this.body += String(chunk); },
    end(chunk = "") { this.body += String(chunk); this.writableEnded = true; },
  };
  const chat = createChatHandler({ client, directory: "/remote", defaultModel: "" });
  await chat.handle({}, response, {
    model: "opencode/test",
    stream: true,
    messages: [{ role: "user", content: "answer briefly" }],
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /snapshot answer/);
});
