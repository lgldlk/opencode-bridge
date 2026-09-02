const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
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

function findCacheKeys(value, pathName = "") {
  const found = [];
  if (!value || typeof value !== "object") return found;
  for (const [key, item] of Object.entries(value)) {
    const current = pathName ? `${pathName}.${key}` : key;
    if (/cache.?key/i.test(key)) found.push({ path: current, value: item });
    if (item && typeof item === "object") found.push(...findCacheKeys(item, current));
  }
  return found;
}

async function main() {
  const providerRequests = [];
  const allProviderRequests = [];
  const provider = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    allProviderRequests.push(body);
    const requestText = JSON.stringify(body);
    const isBridgeTurn = (requestText.includes("first local turn") || requestText.includes("second local turn"))
      && !requestText.includes("Generate a title for this conversation");
    if (isBridgeTurn) providerRequests.push(body);
    const cached = providerRequests.length > 1 ? 80 : 0;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const id = `mock-${providerRequests.length}`;
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "local-ok" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: cached } } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const providerPort = await listen(provider);
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-local-cache-"));
  const configDir = path.join(temp, "config");
  const projectDir = path.join(temp, "project");
  await fs.promises.mkdir(path.join(configDir, "opencode"), { recursive: true });
  await fs.promises.mkdir(projectDir, { recursive: true });
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

  const env = {
    ...process.env,
    HOME: temp,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: path.join(temp, "data"),
    XDG_STATE_HOME: path.join(temp, "state"),
    XDG_CACHE_HOME: path.join(temp, "cache"),
  };
  const opencode = spawn(opencodeBin, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: projectDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let opencodeOutput = "";
  opencode.stdout.on("data", (chunk) => { opencodeOutput += chunk; });
  opencode.stderr.on("data", (chunk) => { opencodeOutput += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenCode startup timeout\n${opencodeOutput}`)), 30_000);
    const poll = setInterval(async () => {
      const match = opencodeOutput.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    }, 100);
    opencode.once("exit", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`OpenCode exited ${code}\n${opencodeOutput}`));
    });
  });
  const opencodePort = Number(opencodeOutput.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
  if (!opencodePort) throw new Error(`unable to parse OpenCode port\n${opencodeOutput}`);

  const bridgePort = await new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
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
  let bridgeOutput = "";
  bridge.stdout.on("data", (chunk) => { bridgeOutput += chunk; });
  bridge.stderr.on("data", (chunk) => { bridgeOutput += chunk; });
  await waitFor(bridge, "opencode bridge listening");

  const endpoint = `http://127.0.0.1:${bridgePort}/v1/chat/completions`;
  const headers = { authorization: "Bearer bridge-test-key", "content-type": "application/json" };
  const first = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "mock-openai/test",
      prompt_cache_key: "local-pi-session",
      messages: [{ role: "user", content: "first local turn" }],
    }),
  });
  const firstBody = await first.json();
  const second = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "mock-openai/test",
      prompt_cache_key: "local-pi-session",
      messages: [
        { role: "user", content: "first local turn" },
        { role: "assistant", content: "local-ok" },
        { role: "user", content: "second local turn" },
      ],
    }),
  });
  const secondBody = await second.json();
  console.log(JSON.stringify({
    firstStatus: first.status,
    secondStatus: second.status,
    firstUsage: firstBody.usage,
    secondUsage: secondBody.usage,
    providerRequests: providerRequests.length,
    allProviderCallCount: allProviderRequests.length,
    allProviderMessages: allProviderRequests.map((item) => item.messages?.map((message) => message.content).join("|") || ""),
    providerPromptCacheKeys: providerRequests.map((item) => item.promptCacheKey || item.prompt_cache_key || null),
    providerCacheKeyFields: providerRequests.map((item) => findCacheKeys(item)),
    opencodeOutput: opencodeOutput.slice(-4000),
    bridgeOutput: bridgeOutput.slice(-4000),
  }, null, 2));
  if (first.status !== 200 || second.status !== 200) throw new Error("bridge request failed");
  if (providerRequests.length !== 2) throw new Error(`expected 2 bridge provider calls, got ${providerRequests.length}`);
  if (Number(secondBody.usage?.prompt_tokens_details?.cached_tokens || 0) <= 0) {
    throw new Error("second turn did not report cached tokens");
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
