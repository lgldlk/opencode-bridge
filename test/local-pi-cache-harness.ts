const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const piBin = process.env.PI_BIN || "pi";
const opencodeBin = path.join(process.env.HOME || "", ".opencode/bin/opencode");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function waitFor(child, text, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${text}\n${output}`)), timeout);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(text)) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve(output);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited ${code} before ${text}\n${output}`));
    });
  });
}

async function runPi(args, env) {
  const child = spawn(piBin, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  return { code, stdout, stderr };
}

function parsePiJsonLines(output) {
  return output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function lastAssistantUsage(output) {
  const records = parsePiJsonLines(output);
  const messages = records.flatMap((record) => [
    ...(record.message ? [record.message] : []),
    ...(Array.isArray(record.messages) ? record.messages : []),
  ]);
  return [...messages].reverse().find((message) => message?.role === "assistant")?.usage || null;
}

function estimatedTokens(value) {
  return Math.max(1, Math.ceil(String(value || "").length / 4));
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function textValue(value) {
  return typeof value === "string" ? value : "";
}

function systemPrompt(body) {
  return Array.isArray(body?.messages)
    ? textValue(body.messages.find((message) => message?.role === "system")?.content)
    : "";
}

function systemDifference(leftBody, rightBody) {
  const left = systemPrompt(leftBody);
  const right = systemPrompt(rightBody);
  const index = commonPrefixLength(left, right);
  return {
    leftChars: left.length,
    rightChars: right.length,
    sharedPrefixChars: index,
    leftAtDifference: left.slice(Math.max(0, index - 160), index + 320),
    rightAtDifference: right.slice(Math.max(0, index - 160), index + 320),
  };
}

async function main() {
  const providerRequests = [];
  const previousPrompts = new Map();
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const cacheKey = body.prompt_cache_key || body.promptCacheKey || req.headers["x-session-affinity"] || null;
    const promptText = JSON.stringify(body.messages || body.input || body);
    const isTitleRequest = Array.isArray(body.messages)
      && body.messages.some((message) => typeof message?.content === "string" && message.content.includes("Generate a title for this conversation:"));
    const previousPrompt = !isTitleRequest && cacheKey ? previousPrompts.get(cacheKey) : null;
    const promptTokens = estimatedTokens(promptText);
    const sharedPrefixChars = previousPrompt ? commonPrefixLength(previousPrompt, promptText) : 0;
    const cached = previousPrompt && previousPrompt.length > 1000
      ? Math.min(promptTokens, Math.max(1, Math.ceil(sharedPrefixChars / 4)))
      : 0;
    if (!isTitleRequest && cacheKey) previousPrompts.set(cacheKey, promptText);
    providerRequests.push({
      headers: req.headers,
      body,
      cacheKey,
      isTitleRequest,
      promptTokens,
      cachedTokens: cached,
      sharedPrefixChars,
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const id = `mock-${providerRequests.length}`;
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "pi-local-ok" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1, prompt_tokens_details: { cached_tokens: cached } } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const providerPort = await listen(provider);
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-pi-cache-"));
  const configDir = path.join(temp, "opencode-config");
  const agentDir = path.join(temp, "pi-agent");
  const sessionsDir = path.join(temp, "pi-sessions");
  const projectDir = path.join(temp, "project");
  await fs.promises.mkdir(path.join(configDir, "opencode"), { recursive: true });
  await fs.promises.mkdir(projectDir, { recursive: true });
  await fs.promises.mkdir(agentDir, { recursive: true });
  await fs.promises.writeFile(path.join(configDir, "opencode", "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    "agent": { "build": { "prompt": "You are a deterministic local cache test assistant." } },
    "provider": {
      "mock-openai": {
        "npm": "@ai-sdk/openai-compatible",
        "options": { "baseURL": `http://127.0.0.1:${providerPort}/v1`, "apiKey": "mock-key", "setCacheKey": true },
        "models": { "test": { "name": "Local cache test", "limit": { "context": 100000, "output": 1000 } } },
      },
    },
  }, null, 2));
  await fs.promises.writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "local-bridge": {
        baseUrl: "http://127.0.0.1:0/v1",
        api: "openai-completions",
        apiKey: "bridge-test-key",
        compat: {
          sendSessionAffinityHeaders: true,
          sessionAffinityFormat: "openai",
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: [{ id: "mock-openai/test", name: "Local bridge test", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000 }],
      },
    },
  }, null, 2));

  const commonEnv = {
    ...process.env,
    HOME: temp,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: path.join(temp, "data"),
    XDG_STATE_HOME: path.join(temp, "state"),
    XDG_CACHE_HOME: path.join(temp, "cache"),
  };
  const opencode = spawn(opencodeBin, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: projectDir, env: commonEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  let opencodeOutput = "";
  opencode.stdout.on("data", (chunk) => { opencodeOutput += chunk; });
  opencode.stderr.on("data", (chunk) => { opencodeOutput += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenCode startup timeout\n${opencodeOutput}`)), 30_000);
    const poll = setInterval(() => {
      if (!opencodeOutput.match(/http:\/\/127\.0\.0\.1:(\d+)/)) return;
      clearTimeout(timer); clearInterval(poll); resolve();
    }, 100);
    opencode.once("exit", (code) => {
      clearTimeout(timer); clearInterval(poll);
      reject(new Error(`OpenCode exited ${code}\n${opencodeOutput}`));
    });
  });
  const opencodePort = Number(opencodeOutput.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
  const bridgePort = await new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const models = JSON.parse(await fs.promises.readFile(path.join(agentDir, "models.json"), "utf8"));
  models.providers["local-bridge"].baseUrl = `http://127.0.0.1:${bridgePort}/v1`;
  await fs.promises.writeFile(path.join(agentDir, "models.json"), JSON.stringify(models, null, 2));
  const bridge = spawn(process.execPath, ["--experimental-strip-types", path.join(root, "src/machine.ts")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(bridgePort),
      HOST: "127.0.0.1",
      BRIDGE_KEY: "bridge-test-key",
      OPENCODE_USERNAME: "opencode",
      OPENCODE_PASSWORD: "unused",
      OPENCODE_URL: `http://127.0.0.1:${opencodePort}`,
      OPENCODE_DIRECTORY: projectDir,
      DEFAULT_MODEL: "mock-openai/test",
      OPENCODE_FIRST_DATA_TIMEOUT_MS: "15000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bridgeOutputPromise = waitFor(bridge, "opencode bridge listening");

  const piEnv = { ...commonEnv, PI_CODING_AGENT_DIR: agentDir };
  const piArgs = [
    "--provider", "local-bridge",
    "--model", "mock-openai/test",
    "--mode", "json",
    "--print",
    "--session-id", "stable-pi-session",
    "--session-dir", sessionsDir,
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--offline",
  ];
  await bridgeOutputPromise;
  const longTask = process.env.LONG_TASK === "1";
  const firstPrompt = longTask
    ? [
      "完成一个长任务：设计并实现一个可靠的本地开发工具链。",
      ...Array.from({ length: 180 }, (_, index) => (
        `需求条目 ${index + 1}：分析第 ${index + 1} 个边界条件、错误恢复、日志字段、缓存策略和测试方案，` +
        "给出可执行的工程实现，并保持前后端协议兼容。"
      )),
    ].join("\n")
    : "first local Pi turn";
  const secondPrompt = longTask
    ? "继续这个长任务：检查上一轮的设计，补充遗漏的异常路径、性能指标、回滚方案和集成测试，并给出最终验收清单。"
    : "second local Pi turn";
  const rounds = Math.max(2, Number(process.env.ROUNDS || 2));
  const prompts = [firstPrompt, ...Array.from({ length: rounds - 1 }, (_, index) => (
    longTask
      ? `继续这个长任务第 ${index + 2} 轮：基于前面已经完成的设计，补充第 ${index + 2} 轮的异常路径、性能指标、回滚方案、兼容性风险和最终验收项。不要重复已经确认的内容，给出新增结论。`
      : index === 0 ? secondPrompt : `继续第 ${index + 1} 轮，补充新的边界条件和验收结论。`
  ))];
  const results = [];
  for (const prompt of prompts) {
    results.push(await runPi([...piArgs, prompt], piEnv));
  }
  const first = results[0];
  const second = results[1];
  const firstUsage = lastAssistantUsage(first.stdout);
  const secondUsage = lastAssistantUsage(second.stdout);
  const mainProviderRequests = providerRequests.filter((item) => !item.isTitleRequest);
  const measuredRequests = mainProviderRequests.slice(-rounds);
  const cacheRates = measuredRequests.map((item) => ({
    promptTokens: item.promptTokens,
    cachedTokens: item.cachedTokens,
    cacheRate: item.promptTokens ? item.cachedTokens / item.promptTokens : 0,
  }));
  const aggregatePromptTokens = measuredRequests.reduce((sum, item) => sum + item.promptTokens, 0);
  const aggregateCachedTokens = measuredRequests.reduce((sum, item) => sum + item.cachedTokens, 0);
  console.log(JSON.stringify({
    piVersion: String(require("child_process").execFileSync(piBin, ["--version"], { encoding: "utf8" })).trim(),
    firstExit: first.code,
    secondExit: second.code,
    rounds,
    roundExitCodes: results.map((result) => result.code),
    firstOutput: first.stdout.slice(-4000),
    secondOutput: second.stdout.slice(-4000),
    firstUsage,
    secondUsage,
    cacheSummary: {
      measuredRounds: measuredRequests.length,
      aggregatePromptTokens,
      aggregateCachedTokens,
      aggregateCacheRate: aggregatePromptTokens ? aggregateCachedTokens / aggregatePromptTokens : 0,
      perRound: cacheRates,
    },
    longTask,
    firstError: first.stderr.slice(-2000),
    secondError: second.stderr.slice(-2000),
    providerCalls: providerRequests.length,
    providerCacheKeys: providerRequests.map((item) => item.cacheKey),
    providerTokenAccounting: providerRequests.map((item) => ({
      promptTokens: item.promptTokens,
      cachedTokens: item.cachedTokens,
      cacheRate: item.promptTokens ? item.cachedTokens / item.promptTokens : 0,
      sharedPrefixChars: item.sharedPrefixChars,
    })),
    providerMessageSummary: providerRequests.map((item) => ({
      cacheKey: item.cacheKey,
      messages: Array.isArray(item.body.messages)
        ? item.body.messages.map((message) => ({
          role: message.role,
          contentChars: textValue(message.content).length || JSON.stringify(message.content || "").length,
          contentPrefix: textValue(message.content).slice(0, 120),
        }))
        : [],
      systemChars: Array.isArray(item.body.messages)
        ? textValue(item.body.messages.find((message) => message.role === "system")?.content).length
        : 0,
    })),
    providerSessionHeaders: providerRequests.map((item) => ({
      "x-session-affinity": item.headers["x-session-affinity"] || null,
      "x-client-request-id": item.headers["x-client-request-id"] || null,
      session_id: item.headers.session_id || null,
    })),
    systemDifference: mainProviderRequests.length >= 2
      ? systemDifference(mainProviderRequests[0].body, mainProviderRequests[1].body)
      : null,
  }, null, 2));
  if (results.some((result) => result.code !== 0)) throw new Error("Pi invocation failed");
  if (measuredRequests.length < rounds) throw new Error(`expected ${rounds} main provider calls, got ${measuredRequests.length}`);
  if (Number(secondUsage?.cacheRead || 0) <= 0) {
    throw new Error(`Pi did not report cached input on the second turn: ${JSON.stringify(secondUsage)}`);
  }
  const cacheKeyRequests = providerRequests.filter((item) => item.cacheKey);
  if (cacheKeyRequests.length < 2 || new Set(cacheKeyRequests.map((item) => item.cacheKey)).size !== 1) {
    throw new Error(`provider prompt cache key was not stable: ${JSON.stringify(cacheKeyRequests.map((item) => item.cacheKey))}`);
  }
  bridge.kill("SIGTERM");
  opencode.kill("SIGTERM");
  await new Promise((resolve) => provider.close(resolve));
  await fs.promises.rm(temp, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
