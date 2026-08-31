"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { json, sseHeaders, sseDataHeartbeat, SSE_HEARTBEAT_INTERVAL_MS, httpError } = require("../shared/http.ts");
const { completion, extractText, selectModel } = require("./models.ts");
const { clientToolContract, sanitizeClientToolArguments, validateClientToolArguments } = require("./tool-contract.ts");
const { renderOpenCodePrompt } = require("./canonical-messages.ts");
const { usageFromMessage, toOpenAIUsage } = require("../shared/usage.ts");

const FALLBACK_TOOL_IDS = [
  "invalid", "question", "bash", "read", "glob", "grep", "edit", "write",
  "task", "webfetch", "todowrite", "websearch", "skill", "apply_patch",
];
const bridgePool = {
  free: [],
  waiters: [],
  slots: new Map(),
  initialized: false,
};
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

function sessionTtlMs() {
  const value = Number(process.env.OPENCODE_SESSION_TTL_MS || DEFAULT_SESSION_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SESSION_TTL_MS;
}

function requestSessionKey(req, body) {
  const headers = req?.headers || {};
  const explicit = headers["x-session-id"] || headers["x-conversation-id"]
    || headers["x-opencode-session-id"] || body?.session_id || body?.conversation_id
    || body?.metadata?.session_id || body?.metadata?.conversation_id;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim().slice(0, 256);
  return null;
}

// OpenCode stores provider failures on assistant message.info.error rather
// than always emitting a dedicated session.error event. Normalize that shape
// so the manager can classify quota/rate-limit failures and fail over.
function normalizeOpenCodeError(value) {
  const source = value && typeof value === "object" ? value : {};
  const data = source.data && typeof source.data === "object" ? source.data : {};
  let message = source.message || data.message || "";
  if (!message && typeof data.responseBody === "string") {
    try {
      const body = JSON.parse(data.responseBody);
      message = body?.error?.message || body?.message || "";
    } catch { /* provider returned a non-JSON body */ }
  }
  const status = Number(source.statusCode || source.status || data.statusCode || data.status);
  const normalizedStatus = Number.isInteger(status) && status > 0 ? status : undefined;
  const type = normalizedStatus === 429 ? "rate_limit_error" : "upstream_error";
  return {
    message: String(message || "OpenCode session failed"),
    status: normalizedStatus,
    type,
    details: {
      provider: data.metadata?.url ? String(data.metadata.url) : undefined,
      status: normalizedStatus,
      retryable: data.isRetryable,
    },
  };
}

function bridgePoolSize() {
  const value = Number(process.env.OPENCODE_TOOL_BRIDGE_POOL_SIZE || 8);
  return Number.isSafeInteger(value) && value > 0 ? value : 8;
}

function initializeBridgePool() {
  if (bridgePool.initialized) return;
  bridgePool.initialized = true;
  for (let index = 0; index < bridgePoolSize(); index += 1) bridgePool.free.push(`opencode_bridge_${index}`);
}

async function acquireBridgeSlot(signal = undefined) {
  initializeBridgePool();
  if (signal?.aborted) throw signal.reason || httpError("Request cancelled", 499);
  if (bridgePool.free.length) return bridgePool.free.shift();
  return new Promise((resolve, reject) => {
    const waiter = { active: true, resolve: null };
    const timeoutMs = Number(process.env.OPENCODE_TOOL_BRIDGE_ACQUIRE_TIMEOUT_MS || 10_000);
    const timer = setTimeout(() => {
      if (!waiter.active) return;
      waiter.active = false;
      bridgePool.waiters = bridgePool.waiters.filter((entry) => entry !== waiter);
      reject(httpError("Tool bridge capacity timed out", 503));
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000);
    timer.unref?.();
    const onAbort = () => {
      if (!waiter.active) return;
      waiter.active = false;
      clearTimeout(timer);
      bridgePool.waiters = bridgePool.waiters.filter((entry) => entry !== waiter);
      reject(signal.reason || httpError("Request cancelled", 499));
    };
    waiter.resolve = (slot) => {
      if (!waiter.active) return false;
      waiter.active = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(slot);
      return true;
    };
    bridgePool.waiters.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseBridgeSlot(slot) {
  if (!slot) return;
  while (bridgePool.waiters.length) {
    const waiter = bridgePool.waiters.shift();
    if (waiter.resolve(slot)) return;
  }
  if (!bridgePool.free.includes(slot)) bridgePool.free.push(slot);
}

function clientToolDefinitions(tools) {
  const result = new Map();
  for (const item of Array.isArray(tools) ? tools : []) {
    const source = item?.function || item?.custom || item;
    const name = source?.name;
    if (typeof name !== "string" || !name) continue;
    result.set(name, {
      name,
      description: typeof source.description === "string" ? source.description : "",
      parameters: source.parameters && typeof source.parameters === "object" ? source.parameters : {},
    });
  }
  return result;
}

function applyToolChoice(definitions, choice) {
  if (choice === "none") return new Map();
  if (choice && typeof choice === "object") {
    const name = choice.function?.name ?? choice.name;
    if (choice.type === "function" && typeof name === "string" && name) {
      const selected = definitions.get(name);
      return selected ? new Map([[name, selected]]) : new Map();
    }
  }
  return definitions;
}

function sanitizeToolName(name, seen = new Set()) {
  let value = String(name || "tool").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
  if (!value || !/^[a-zA-Z_]/.test(value)) value = `tool_${value}`;
  let candidate = value;
  let suffix = 2;
  while (seen.has(candidate)) candidate = `${value}_${suffix++}`;
  seen.add(candidate);
  return candidate;
}

function clientToolMap(definitions, discovered = FALLBACK_TOOL_IDS) {
  const available = new Set(discovered);
  const result = new Map();
  for (const name of definitions.keys()) {
    if (available.has(name)) result.set(name, name);
  }
  if (!result.has("glob") && definitions.has("find") && available.has("glob")) {
    result.set("glob", "find");
  }
  return result;
}

function disableToolIds(discovered) {
  const ids = new Set();
  for (const name of Array.isArray(discovered) ? discovered : []) {
    ids.add(name);
    ids.add(`default.${name}`);
  }
  return Object.fromEntries([...ids].map((name) => [name, false]));
}

function mapToolInput(openCodeName, clientName, input, definition) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  const properties = definition?.parameters?.properties;
  if (source.filePath !== undefined && source.path === undefined) source.path = source.filePath;
  delete source.filePath;
  if (clientName === "edit" && !Array.isArray(source.edits) && source.oldString !== undefined) {
    if (properties?.edits !== undefined || !properties || Object.keys(properties).length === 0) {
      source.edits = [{ oldText: source.oldString, newText: source.newString ?? "" }];
    }
  }
  if (properties?.edits !== undefined || !properties || Object.keys(properties).length === 0) {
    delete source.oldString;
    delete source.newString;
  }
  if (openCodeName === "glob" && clientName === "find" && source.pattern === undefined && source.glob !== undefined) {
    source.pattern = source.glob;
  }
  delete source.glob;

  if (!properties || typeof properties !== "object") return source;
  return Object.fromEntries(Object.entries(source).filter(([key]) => Object.hasOwn(properties, key)));
}

function decodeToolInput(state: any = {}) {
  const input = state.input;
  if (input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length > 0) {
    return input;
  }
  for (const raw of [state.raw, state.arguments, state.input]) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Some providers emit partial JSON while the tool is pending. The next
      // running/completed snapshot remains authoritative.
    }
  }
  return {};
}

function sessionPermission(toolMap) {
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...toolMap.keys().map((name) => ({ permission: name, pattern: "*", action: "ask" })),
  ];
}

function toolCompletion(id, model, calls, usage = undefined) {
  const list = Array.isArray(calls) ? calls : [calls];
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: list.filter(Boolean).map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })),
      },
      finish_reason: "tool_calls",
    }],
    ...(usage ? { usage: toOpenAIUsage(usage) } : {}),
  };
}

function createChatHandler({
  client,
  directory,
  defaultModel,
  firstDataTimeoutMs = 900_000,
  eventConnectTimeoutMs = 15_000,
}) {
  const sessions = new Map();

  function sessionFor(key, model) {
    if (!key) return null;
    const current = sessions.get(key);
    if (!current || current.model !== model || Date.now() - current.lastUsedAt > sessionTtlMs()) {
      if (current?.id) void client.sessionDelete?.(current.id).catch(() => {});
      sessions.delete(key);
      return null;
    }
    current.lastUsedAt = Date.now();
    return current;
  }
  async function resolveModel(name) {
    const requested = name || defaultModel;
    if (requested.includes("/")) return selectModel(undefined, requested);
    return selectModel(await client.providers(), requested);
  }

  async function sendMessage(sessionId, payload, signal = undefined) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return client.request(`/session/${encodeURIComponent(sessionId)}/message${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  }

  async function createSession(permission = undefined) {
    return client.request(`/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(permission ? { permission } : {}),
    });
  }

  async function rejectPermission(sessionId, permissionId) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return client.request(`/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "reject" }),
    });
  }

  async function discoveredToolIds() {
    try {
      const discovered = await client.toolIds?.();
      return Array.isArray(discovered) && discovered.length ? discovered : FALLBACK_TOOL_IDS;
    } catch (error) {
      console.warn(`[machine] unable to discover OpenCode tools; using fallback list: ${error.message}`);
      return FALLBACK_TOOL_IDS;
    }
  }

  async function disabledTools() {
    return disableToolIds(await discoveredToolIds());
  }

  async function createToolBridge(definitions) {
    if (!client.mcpAdd || !client.mcpDisconnect) return null;
    const bridgeName = await acquireBridgeSlot();
    const seen = new Set();
    const nameMap = new Map();
    const bridgeTools = [...definitions.values()].map((definition) => {
      const bridgeToolName = sanitizeToolName(definition.name, seen);
      const fullName = `${bridgeName}_${bridgeToolName}`;
      nameMap.set(fullName, definition.name);
      return {
        name: bridgeToolName,
        description: definition.description || "",
        parameters: definition.parameters,
      };
    });
    try {
      // OpenCode has no remove-MCP endpoint. Reusing a bounded pool and
      // disconnecting before re-registering prevents stale tool schemas and an
      // ever-growing catalogue in long-lived machine processes.
      await client.mcpDisconnect(bridgeName).catch(() => {});
      const bridgePath = process.env.OPENCODE_BRIDGE_MCP_PATH
        || path.join(__dirname, "mcp-tool-bridge.ts");
      await client.mcpAdd(bridgeName, {
        type: "local",
        command: [process.execPath, "--experimental-strip-types", bridgePath],
        environment: { OPENCODE_BRIDGE_TOOLS: JSON.stringify(bridgeTools) },
        enabled: true,
        timeout: 10_000,
      });
      await client.mcpConnect?.(bridgeName);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const toolIds = [...nameMap.keys()];
      bridgePool.slots.set(bridgeName, toolIds);
      return { name: bridgeName, toolIds, nameMap };
    } catch (error) {
      releaseBridgeSlot(bridgeName);
      throw error;
    }
  }

  async function handle(req, res, body) {
    const selected = await resolveModel(body.model);
    const model = selected.name;
    const sessionKey = requestSessionKey(req, body);
    const existingSession = sessionFor(sessionKey, model);
    const discoveredTools = await discoveredToolIds();
    const definitions = applyToolChoice(
      clientToolDefinitions(body.tools ?? body.functions),
      body.tool_choice,
    );
    const toolMap = clientToolMap(definitions, discoveredTools);
    const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
    const messagesForPrompt = existingSession && existingSession.messageCount < incomingMessages.length
      ? incomingMessages.slice(existingSession.messageCount)
      : existingSession && existingSession.messageCount === incomingMessages.length
        ? incomingMessages.slice(-1)
        : incomingMessages;
    const canonicalPrompt = renderOpenCodePrompt(messagesForPrompt);
    // Keep the caller's tools available on every request. Tool history is
    // represented in the prompt context; disabling tools based on message
    // shape would break legitimate follow-up tool calls.
    const clientTools = definitions.size > 0 && body.tool_choice !== "none";
    if (clientTools) {
      console.log(`[machine-tools] offered=${[...definitions.values()].map((definition) => {
        const parameters = definition.parameters && typeof definition.parameters === "object" ? definition.parameters : {};
        const required = Array.isArray(parameters.required) ? parameters.required.join(",") : "-";
        return `${definition.name}[required=${required}]`;
      }).join(",")}`);
    }
    let toolBridge = null;
    if (clientTools) {
      try {
        if (!client.mcpAdd || !client.mcpDisconnect) {
          throw new Error("OpenCode MCP API is unavailable");
        }
        toolBridge = await createToolBridge(definitions);
        if (!toolBridge) throw new Error("OpenCode MCP tool bridge was not created");
      } catch (error) {
        // A native OpenCode tool runs in the machine's workspace. Falling
        // back here would make a caller's local edit/read/write execute on
        // the remote host, which violates the bridge contract. Fail closed
        // and let the manager retry another machine instead.
        const bridgeError = httpError(
          `Client tool bridge unavailable; refusing remote tool execution: ${error.message}`,
          503,
          { type: "client_tool_bridge_unavailable" },
        );
        if (res && !res.writableEnded) {
          return json(res, bridgeError.status, {
            error: {
              message: bridgeError.message,
              type: bridgeError.data.type,
            },
          });
        }
        throw bridgeError;
      }
    }
    // Do not inject tool-specific instructions into the model prompt.  MCP
    // exposes the caller's schemas as ordinary tools; the upstream client
    // system/developer messages are the only system content we forward.
    const systemPrompt = canonicalPrompt.system || undefined;
    const payload = {
      parts: [{ type: "text", text: canonicalPrompt.text }],
      model: selected.ref,
      // OpenCode's default agent can be changed by the server configuration
      // (for example to `plan`), which intentionally avoids execution tools.
      // This bridge is a model-only frontend for the caller's local tools, so
      // use the execution-capable build agent unless the operator explicitly
      // overrides it on the machine.
      agent: process.env.OPENCODE_AGENT || "build",
      // OpenCode converts message-level `tools: { read: true }` into an allow
      // permission and overwrites the session's `ask` rule. Omit `tools` while
      // capturing client calls so execution pauses at `permission.asked`.
      // Text-only requests explicitly disable every remote tool.
      ...(!clientTools
        ? { tools: disableToolIds(discoveredTools) }
        : toolBridge
          ? {
            tools: {
              ...disableToolIds(discoveredTools),
              ...Object.fromEntries([...bridgePool.slots.values()].flat().map((name) => [name, false])),
              ...Object.fromEntries(toolBridge.toolIds.map((name) => [name, true])),
            },
          }
          : {}),
      ...(systemPrompt ? { system: systemPrompt } : {}),
      ...(body.temperature === undefined ? {} : { variant: String(body.temperature) }),
    };
    const id = crypto.randomBytes(12).toString("hex");
    const eventController = new AbortController();
    const abortOnClientClose = () => {
      if (!eventController.signal.aborted) {
        eventController.abort(Object.assign(new Error("Client connection closed"), { name: "AbortError" }));
      }
    };
    req?.once?.("aborted", abortOnClientClose);
    res?.once?.("close", abortOnClientClose);
    let sessionId = "";
    let sentRole = false;
    let streamedText = "";
    let bufferedText = "";
    const capturedToolCalls = new Map();
    let invalidToolError = null;
    const pendingToolInputs = new Map();
    const pendingPermissions = new Map();
    let syncFinalizeTimer;
    let idleSettleTimer;
    const partText = new Map();
    const assistantMessageIds = new Set();
    const messageRoles = new Map();
    const pendingUnknownTextDeltas = new Map();
    const deltaParts = new Set();
    let toolMessageId = null;
    let eventCount = 0;
    let firstDataAt = null;
    let lastDataAt = null;
    const startedAt = Date.now();
    let terminalResolve;
    const terminal = new Promise((resolve) => { terminalResolve = resolve; });
    let errorWatcherPromise = Promise.resolve();
    let persistentSession = false;
    let observedUsage = null;
    const asyncLifecycle = typeof client.promptAsync === "function" && typeof client.sessionMessages === "function";
    let asyncTurn = asyncLifecycle;

    const markData = () => {
      if (!firstDataAt) firstDataAt = Date.now();
      lastDataAt = Date.now();
    };
    const sendDelta = (text, options: any = {}) => {
      if (!text) return;
      markData();
      if (!options.skipAccumulate) streamedText += text;
      // A model may emit a short natural-language preamble before proposing a
      // client tool call. Sending that text immediately
      // makes some OpenAI clients treat the assistant turn as complete and
      // never execute the later tool_calls frame. Buffer text while tools are
      // enabled; flush it only after the turn is known to be text-only.
      if (clientTools && capturedToolCalls.size === 0 && !options.forceEmit) {
        bufferedText += text;
        return;
      }
      if (!body.stream || res.writableEnded) return;
      const chunk = {
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { ...(sentRole ? {} : { role: "assistant" }), content: text }, finish_reason: null }],
      };
      sentRole = true;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    const flushAssistantDeltas = (messageId) => {
      const pending = pendingUnknownTextDeltas.get(messageId);
      if (!pending) return;
      pendingUnknownTextDeltas.delete(messageId);
      for (const delta of pending) sendDelta(delta);
    };
    const bufferUnknownDelta = (messageId, delta) => {
      if (!messageId || !delta) return;
      const pending = pendingUnknownTextDeltas.get(messageId) || [];
      // Event ordering should resolve immediately. Keep a small bounded buffer
      // rather than risking caller prompt text being relayed as model output.
      if (pending.length < 64) pending.push(delta);
      pendingUnknownTextDeltas.set(messageId, pending);
    };
    const finalizeTool = (callID, force = false) => {
      const pending = pendingToolInputs.get(callID);
      const permission = pendingPermissions.get(callID);
      if (!pending || capturedToolCalls.has(callID)) return;
      if (!permission && !toolBridge) return;
      const hasInput = pending.input
        && typeof pending.input === "object"
        && !Array.isArray(pending.input)
        && Object.keys(pending.input).length > 0;
      // OpenCode emits a pending tool part with `{}` before the running part
      // contains the actual arguments. Do not abort on that first snapshot.
      if (!hasInput && !force) return;
      const definition = definitions.get(pending.clientName);
      // MCP exposes the caller's exact schema, therefore its arguments are
      // already in the caller's namespace. Never rewrite or infer fields on
      // The MCP bridge exposes the caller's exact schema, so preserve the
      // caller-facing arguments byte-for-byte on this path.
      const argumentsValue = toolBridge
        ? (pending.input && typeof pending.input === "object" ? pending.input : {})
        : mapToolInput(pending.openCodeName, pending.clientName, pending.input, definition);
      const validation = sanitizeClientToolArguments(pending.clientName, argumentsValue, definition, {
        // Argument validation is schema-driven only. Filesystem locality is
        // determined by the client that executes the call, never by a
        // hard-coded path prefix on this machine.
      });
      if (!validation.ok) {
        invalidToolError = validation.error;
        console.warn(
          `[machine-tools] rejected invalid client tool call model=${model} `
          + `remoteTool=${pending.openCodeName} tool=${pending.clientName} `
          + `inputKeys=${Object.keys(pending.input || {}).join(",") || "-"} `
          + `permission=${permission ? "yes" : "no"}: ${validation.error.message}`,
        );
        if (!permission) {
          eventController.abort();
          return;
        }
        void rejectPermission(sessionId, permission.id)
          .catch((error) => console.warn(`[machine-tools] unable to reject invalid remote execution: ${error.message}`))
          .finally(() => eventController.abort());
        return;
      }
      capturedToolCalls.set(callID, {
        id: callID,
        name: pending.clientName,
        arguments: validation.value,
      });
      bufferedText = "";
      markData();
      if (permission) {
        void rejectPermission(sessionId, permission.id)
          .catch((error) => console.warn(`[machine-tools] unable to reject remote execution: ${error.message}`))
          .finally(() => eventController.abort());
      } else {
        eventController.abort();
      }
    };
    const captureTool = (part) => {
      if (!clientTools || !part?.callID) return;
      // `session.idle` can race the final MCP part on remote OpenCode
      // instances. Keep the idle settle window open while a late tool part
      // arrives; the part itself is authoritative.
      clearTimeout(idleSettleTimer);
      idleSettleTimer = undefined;
      const qualified = typeof part.tool === "string" && part.tool.startsWith("default.")
        ? part.tool.slice("default.".length)
        : part.tool;
      const clientName = toolBridge?.nameMap.get(part.tool)
        || toolMap.get(part.tool)
        || toolMap.get(qualified);
      if (!clientName) return;
      // A session may emit several assistant steps.  Once the first bridge
      // tool message is known, ignore tool parts from later follow-up steps;
      // only the current client-executed turn belongs in this response.
      if (part.messageID && toolMessageId && part.messageID !== toolMessageId) return;
      if (part.messageID && !toolMessageId) toolMessageId = part.messageID;
      const normalizedInput = decodeToolInput(part.state || {});
      const previous = pendingToolInputs.get(part.callID);
      pendingToolInputs.set(part.callID, {
        openCodeName: part.tool,
        clientName,
        input: Object.keys(normalizedInput).length > 0 ? normalizedInput : (previous?.input || {}),
      });
      // OpenCode emits a pending snapshot (`input: {}`) followed by a running
      // snapshot containing the decoded arguments. Keep collecting snapshots;
      // the step-finish event is the authoritative point at which the complete
      // tool call can be returned to the client.
      if (!asyncTurn) {
        // The synchronous compatibility endpoint may not emit a step-finish
        // event on older OpenCode releases. Give same-turn parallel calls a
        // short coalescing window, then finalize the complete set together.
        clearTimeout(syncFinalizeTimer);
        syncFinalizeTimer = setTimeout(() => {
          for (const callID of pendingToolInputs.keys()) finalizeTool(callID);
        }, 25);
        syncFinalizeTimer.unref?.();
      }
    };
    const capturePermission = (permission) => {
      const callID = permission?.callID || permission?.tool?.callID || permission?.metadata?.callID;
      if (!clientTools || !callID || !permission?.id) return;
      pendingPermissions.set(callID, permission);
      finalizeTool(callID);
    };
    const hydrateToolInputs = (result) => {
      const entries = Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : []);
      for (const entry of entries) {
        for (const part of Array.isArray(entry?.parts) ? entry.parts : []) {
          if (part?.type !== "tool" || !part.callID) continue;
          const input = decodeToolInput(part.state || {
            input: part.input,
            arguments: part.arguments,
          });
          // Some OpenCode versions do not emit the tool part on `/event`, but
          // persist it in `GET /session/:id/message`. Treat that response as
          // another authoritative snapshot instead of only enriching calls
          // that happened to be observed on SSE.
          captureTool(part);
          if (input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length > 0) {
            const pending = pendingToolInputs.get(part.callID);
            if (pending) pending.input = input;
          }
          console.warn(
            `[machine-tools] hydrated call=${part.callID} tool=${part.tool || "?"} `
            + `status=${part.state?.status || "?"} inputKeys=${Object.keys(input || {}).join(",") || "-"}`,
          );
        }
      }
    };

    const hasCompleteToolInput = () => [...pendingToolInputs.values()].every((pending) => {
      const input = pending?.input;
      return input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length > 0;
    });

    const hydrateToolInputsWithRetry = async (sessionId) => {
      let latest = null;
      // The async prompt endpoint can publish `session.idle` just before the
      // final tool-part write is visible to the message endpoint. A short,
      // bounded read-after-idle retry closes that race without adding material
      // latency to ordinary text turns.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        latest = await client.sessionMessages(sessionId);
        hydrateToolInputs(latest);
        if (pendingToolInputs.size === 0 || hasCompleteToolInput()) break;
        if (attempt === 3) break;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 100 * (attempt + 1));
          timer.unref?.();
        });
      }
      return latest;
    };

    const eventStream = client.subscribeEvents(eventController.signal, (event) => {
      eventCount += 1;
      const properties = event?.properties;
      const eventSessionId = properties?.sessionID || properties?.part?.sessionID;
      if (!sessionId || (eventSessionId && eventSessionId !== sessionId)) return;
      if (event.type === "permission.asked") {
        capturePermission(properties);
        return;
      }
      if (event.type === "message.updated") {
        const messageId = properties.info?.id;
        const role = properties.info?.role;
        if (role === "assistant") {
          // OpenCode commonly puts token accounting on the message.updated
          // event, while the final /message snapshot may omit it. Keep the
          // latest non-empty usage from either source.
          observedUsage = usageFromMessage({ info: properties.info }) || observedUsage;
        }
        if (properties.info?.error) {
          terminalResolve({ error: normalizeOpenCodeError(properties.info.error) });
        }
        if (messageId && role) {
          messageRoles.set(messageId, role);
          if (role === "assistant") {
            assistantMessageIds.add(messageId);
            flushAssistantDeltas(messageId);
          } else {
            pendingUnknownTextDeltas.delete(messageId);
          }
        }
        return;
      }
      if (event.type === "message.part.updated") {
        const part = properties.part;
        if (part?.type === "tool") {
          captureTool(part);
        } else if (
          part?.type === "step-finish"
          && clientTools
          && capturedToolCalls.size === 0
          && (!toolMessageId || !part.messageID || part.messageID === toolMessageId)
        ) {
          // The step-finish event is the authoritative boundary for tool
          // arguments. Older OpenCode builds may only expose the final input
          // in this event sequence, so flush all pending calls once here.
          for (const callID of pendingToolInputs.keys()) finalizeTool(callID, true);
          terminalResolve("tool-step-finish");
        } else if (part?.type === "text") {
          const messageId = part.messageID || properties.messageID;
          if (!assistantMessageIds.has(messageId)) return;
          const key = part.id || properties.partID || "text";
          const text = String(part.text || "");
          const previous = partText.get(key) || "";
          if (!deltaParts.has(key)) {
            if (text.startsWith(previous)) sendDelta(text.slice(previous.length));
            else if (text !== previous) sendDelta(text);
          }
          partText.set(key, text);
        }
        return;
      }
      if (event.type === "message.part.delta" && properties.field === "text") {
        const messageId = properties.messageID;
        if (!assistantMessageIds.has(messageId)) {
          // OpenCode versions before 0.8 sometimes omit messageID on text
          // deltas. Do not guess that such a delta is assistant output: keep
          // it out of the wire stream and use the persisted assistant message
          // snapshot at turn completion instead.
          if (!messageRoles.has(messageId)) {
            bufferUnknownDelta(messageId || "__unknown__", String(properties.delta || ""));
          }
          return;
        }
        const partKey = properties.partID || `${properties.messageID}:text`;
        deltaParts.add(partKey);
        sendDelta(String(properties.delta || ""));
        return;
      }
      if (event.type === "session.error") {
        terminalResolve({ error: normalizeOpenCodeError(properties.error || properties) });
      } else if (event.type === "session.idle") {
        if (clientTools && capturedToolCalls.size === 0) {
          // Some OpenCode/provider combinations publish `session.idle` just
          // before the final assistant tool part is visible on the event
          // stream. A short, bounded settle window closes that race without
          // guessing a tool or reading the caller's text.
          const configured = Number(process.env.OPENCODE_TOOL_IDLE_SETTLE_MS || 500);
          const settleMs = Number.isFinite(configured) && configured >= 0 ? configured : 500;
          clearTimeout(idleSettleTimer);
          idleSettleTimer = setTimeout(() => {
            idleSettleTimer = undefined;
            terminalResolve("idle");
          }, settleMs);
          idleSettleTimer.unref?.();
        } else {
          terminalResolve("idle");
        }
      }
    });

    let heartbeat;
    let firstDataTimer;
    const sendStreamUsage = (usage) => {
      if (!body.stream || !usage || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({
        id: `usage-${id}`,
        object: "bridge.usage",
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          reasoning_tokens: usage.reasoningTokens,
          cache_read_input_tokens: usage.cacheReadTokens,
          cache_creation_input_tokens: usage.cacheWriteTokens,
        },
      })}\n\n`);
    };
    const sendStreamTool = (toolCalls) => {
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: toolCalls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
            })),
          },
          finish_reason: null,
        }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`);
      res.end("data: [DONE]\n\n");
    };
    const sendStreamDone = () => {
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end("data: [DONE]\n\n");
    };

    try {
      let eventReadyTimer;
      try {
        await Promise.race([
          eventStream.ready,
          new Promise((_, reject) => {
            eventReadyTimer = setTimeout(() => reject(new Error("OpenCode event stream connection timed out")), eventConnectTimeoutMs);
            eventReadyTimer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(eventReadyTimer);
      }

      const session = existingSession
        || await createSession(clientTools && !toolBridge ? sessionPermission(toolMap) : undefined);
      sessionId = session.id;
      persistentSession = Boolean(sessionKey);
      if (persistentSession) {
        sessions.set(sessionKey, {
          id: sessionId,
          model,
          messageCount: incomingMessages.length,
          lastUsedAt: Date.now(),
        });
      }
      // Provider errors are persisted on the assistant message, but some
      // OpenCode releases never publish session.idle/session.error for a
      // failed provider turn. Poll the lightweight message snapshot so a
      // quota error is surfaced immediately instead of waiting for a timeout.
      if (asyncLifecycle) {
        errorWatcherPromise = (async () => {
          while (!eventController.signal.aborted) {
            try {
              const snapshot = await client.sessionMessages(session.id, eventController.signal);
              const entries = Array.isArray(snapshot) ? snapshot : (Array.isArray(snapshot?.data) ? snapshot.data : []);
              const failed = entries.find((entry) => entry?.info?.role === "assistant" && entry.info.error);
              if (failed?.info?.error) {
                terminalResolve({ error: normalizeOpenCodeError(failed.info.error) });
                return;
              }
            } catch {
              if (eventController.signal.aborted) return;
            }
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 500);
              timer.unref?.();
            });
          }
        })();
      }
      if (body.stream) {
        res.writeHead(200, sseHeaders());
        res.flushHeaders?.();
        const heartbeatFrame = sseDataHeartbeat("machine-keep-alive");
        res.write(heartbeatFrame);
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(heartbeatFrame);
        }, SSE_HEARTBEAT_INTERVAL_MS);
      }
      firstDataTimer = setTimeout(() => {
        if (!firstDataAt) eventController.abort();
      }, firstDataTimeoutMs);
      firstDataTimer.unref?.();

      let message;
      if (asyncLifecycle) {
        // Prefer OpenCode's asynchronous prompt endpoint. The synchronous
        // `/message` endpoint keeps the HTTP request open until the whole
        // agent turn completes and is the source of the long-task timeouts
        // seen behind proxies. The event stream is now the completion signal.
        try {
          await client.promptAsync(session.id, payload, eventController.signal);
          const terminalResult = await Promise.race([
            terminal,
            eventStream.done.then(() => "event_end"),
          ]);
          if (terminalResult && typeof terminalResult === "object" && terminalResult.error) {
            const normalized = typeof terminalResult.error === "string"
              ? { message: terminalResult.error, status: undefined, type: "upstream_error", details: undefined }
              : terminalResult.error;
            throw httpError(
              normalized.message,
              normalized.status || 502,
              { type: normalized.type, details: normalized.details },
            );
          }
          if (eventController.signal.aborted && capturedToolCalls.size === 0 && !streamedText && !invalidToolError) {
            throw httpError("OpenCode first model data timed out", 504);
          }
          // Always fetch the persisted message snapshot before finalizing a
          // tool turn. Depending on OpenCode/provider timing, the event stream
          // can expose only a pending `{}` snapshot (or no tool part at all),
          // while the completed arguments are already available here.
          const result = await hydrateToolInputsWithRetry(session.id);
          const entries = Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : []);
          if (capturedToolCalls.size === 0 || !clientTools) {
            message = entries.filter((entry) => entry?.info?.role === "assistant").at(-1)
              || entries.at(-1)
              || null;
          }
          if (message?.info?.error) {
            const normalized = normalizeOpenCodeError(message.info.error);
            throw httpError(normalized.message, normalized.status || 502, {
              type: normalized.type,
              details: normalized.details,
            });
          }
          for (const callID of pendingToolInputs.keys()) finalizeTool(callID, true);
        } catch (error) {
          // OpenCode releases before prompt_async are still supported. Only
          // downgrade on a route-not-found response; all model and network
          // errors must remain visible to the manager for failover.
          if (![404, 405].includes(error?.status) || capturedToolCalls.size > 0 || streamedText) throw error;
          asyncTurn = false;
          message = await sendMessage(session.id, payload, eventController.signal);
        }
      } else {
        try {
          message = await sendMessage(session.id, payload, eventController.signal);
        } catch (error) {
          if (invalidToolError) throw invalidToolError;
          if (capturedToolCalls.size === 0) throw error;
        }
      }
      clearTimeout(firstDataTimer);

      const toolCalls = [...capturedToolCalls.values()];
      const turnUsage = usageFromMessage(message) || observedUsage;
      if (toolCalls.length > 0) {
        if (sessionKey) {
          const stored = sessions.get(sessionKey);
          if (stored) {
            stored.messageCount = incomingMessages.length;
            stored.lastUsedAt = Date.now();
          }
        }
        console.log(`[machine-tools] model=${model} session=${sessionId} tools=${toolCalls.map((call) => call.name).join(",")} events=${eventCount}`);
        if (body.stream) {
          sendStreamUsage(turnUsage);
          sendStreamTool(toolCalls);
        } else json(res, 200, toolCompletion(id, model, toolCalls, turnUsage));
        return;
      }

      if (clientTools) {
        console.warn(
          `[machine-tools] no-call model=${model} session=${sessionId} `
          + `bridge=mcp events=${eventCount} `
          + `pending=${pendingToolInputs.size} text=${streamedText.length}`,
        );
      }
      if (!streamedText) sendDelta(extractText(message));
      if (!streamedText) throw httpError("OpenCode produced no model output", 504);
      console.log(`[machine-stream] model=${model} session=${sessionId} events=${eventCount} firstDataMs=${firstDataAt ? firstDataAt - startedAt : "?"} lastDataMs=${lastDataAt ? lastDataAt - startedAt : "?"} streamed=${streamedText.length}`);
      if (body.stream && bufferedText) {
        const pending = bufferedText;
        bufferedText = "";
        // sendDelta normally buffers while client tools are enabled; force
        // emission only after the turn is confirmed not to contain a call.
        sendDelta(pending, { forceEmit: true, skipAccumulate: true });
      }
      if (body.stream) {
        sendStreamUsage(turnUsage);
        sendStreamDone();
      }
      else json(res, 200, completion(id, model, streamedText, turnUsage?.inputTokens || 0, turnUsage?.outputTokens || 0, turnUsage));
      if (sessionKey) {
        const stored = sessions.get(sessionKey);
        if (stored) {
          stored.messageCount = incomingMessages.length;
          stored.lastUsedAt = Date.now();
        }
      }
    } catch (error) {
      if (error?.name === "AbortError" && capturedToolCalls.size === 0 && !streamedText) error = httpError("OpenCode first model data timed out", 504);
      const message = error?.data?.message || error?.message || "upstream error";
      const status = Number(error?.status || error?.data?.statusCode);
      const code = Number.isInteger(status) && status > 0 ? status : undefined;
      const type = error?.data?.type || (code === 429 ? "rate_limit_error" : "upstream_error");
      console.error(`[machine-stream] model=${model} session=${sessionId || "?"} failed name=${error?.name || "Error"} message=${message}`);
      if (!res.writableEnded) {
        if (body.stream) {
          if (!res.headersSent) res.writeHead(200, sseHeaders());
          res.write(`data: ${JSON.stringify({ error: { message, type, code, tool: error.data?.tool } })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          json(res, code || 502, { error: { message, type, code, tool: error.data?.tool } });
        }
      }
    } finally {
      if (sessionId && client.sessionAbort) {
        await client.sessionAbort(sessionId).catch(() => {});
      }
      eventController.abort();
      clearInterval(heartbeat);
      clearTimeout(firstDataTimer);
      clearTimeout(syncFinalizeTimer);
      clearTimeout(idleSettleTimer);
      await eventStream.done.catch(() => {});
      await errorWatcherPromise.catch(() => {});
      if (sessionId && client.sessionDelete && !persistentSession) {
        await client.sessionDelete(sessionId).catch(() => {});
      }
      if (toolBridge) {
        await client.mcpDisconnect(toolBridge.name).catch((error) => {
          console.warn(`[machine-tools] unable to disconnect MCP bridge: ${error.message}`);
        });
        releaseBridgeSlot(toolBridge.name);
      }
      req?.removeListener?.("aborted", abortOnClientClose);
      res?.removeListener?.("close", abortOnClientClose);
    }
  }

  return { disabledTools, handle, resolveModel };
}

module.exports = {
  applyToolChoice,
  clientToolDefinitions,
  clientToolMap,
  createChatHandler,
  mapToolInput,
  clientToolContract,
  sanitizeClientToolArguments,
  sessionPermission,
  toolCompletion,
  validateClientToolArguments,
};
