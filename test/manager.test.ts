const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function mockMachine(mode = "ok") {
  const state = { mode };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer machine-key") return res.writeHead(401).end();
    if (req.url === "/health") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    if (req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"opencode/big-pickle"}]}');
    if (req.url === "/v1/chat/completions") {
      if (state.mode === "fail") return res.writeHead(503, { "content-type": "application/json" }).end('{"error":{"message":"offline"}}');
      if (state.mode === "rate") return res.writeHead(429, { "retry-after": "10", "content-type": "application/json" }).end('{"error":{"message":"rate limited"}}');
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: input.model, choices: [{ message: { role: "assistant", content: "ok" } }] }));
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

function startManager(configPath, port) {
  const child = spawn(process.execPath, ["--experimental-strip-types", path.join(root, "src/manager.ts")], {
    cwd: root,
    env: { ...process.env, MANAGER_CONFIG: configPath, MANAGER_PORT: String(port), MANAGER_ADMIN_KEY: "admin-key", MANAGER_API_KEY: "client-key", MANAGER_HEALTH_INTERVAL_MS: "60000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`manager startup timeout: ${output}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("listening")) { clearTimeout(timer); resolve(child); }
    });
    child.once("error", reject);
  });
}

async function freePort() {
  const server = http.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("manager aggregates models and fails over server errors, not 429", async (t) => {
  const first = await mockMachine("fail");
  const second = await mockMachine("ok");
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-manager-"));
  const configPath = path.join(tempDir, "config.json");
  await fs.promises.writeFile(configPath, JSON.stringify({ machines: [
    { id: "first", baseUrl: first.url, apiKey: "machine-key" },
    { id: "second", baseUrl: second.url, apiKey: "machine-key" },
  ] }));
  const managerPort = await freePort();
  const manager = await startManager(configPath, managerPort);
  t.after(async () => {
    manager.kill("SIGTERM");
    await Promise.all([new Promise((resolve) => first.server.close(resolve)), new Promise((resolve) => second.server.close(resolve))]);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${managerPort}`;
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer client-key" } }).then((r) => r.json());
  assert.deepEqual(models.data.map((item) => item.id), ["opencode/big-pickle"]);
  const completion = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer client-key", "content-type": "application/json" }, body: JSON.stringify({ model: "opencode/big-pickle", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(completion.status, 200);
  assert.equal((await completion.json()).choices[0].message.content, "ok");
  first.state.mode = "rate";
  second.state.mode = "rate";
  const rate = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer client-key", "content-type": "application/json" }, body: JSON.stringify({ model: "opencode/big-pickle", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(rate.status, 429);
});

test("manager serves the admin console without exposing machine secrets", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-admin-"));
  const configPath = path.join(tempDir, "config.json");
  await fs.promises.writeFile(configPath, JSON.stringify({ machines: [] }));
  const managerPort = await freePort();
  const manager = await startManager(configPath, managerPort);
  t.after(async () => { manager.kill("SIGTERM"); await fs.promises.rm(tempDir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${managerPort}/admin`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /OpenCode Manager/);
  const api = await fetch(`http://127.0.0.1:${managerPort}/admin/machines`);
  assert.equal(api.status, 401);
});

test("manager sends SSE headers and heartbeats before a slow machine responds", async (t) => {
  const machine = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer machine-key") return res.writeHead(401).end();
    if (req.url === "/health") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    if (req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"opencode/big-pickle"}]}');
    if (req.url === "/v1/chat/completions") {
      for await (const _chunk of req) { /* consume request */ }
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {\"id\":\"chatcmpl-test\",\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n");
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => machine.listen(0, "127.0.0.1", resolve));
  const machineUrl = `http://127.0.0.1:${machine.address().port}`;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-manager-stream-"));
  const configPath = path.join(tempDir, "config.json");
  await fs.promises.writeFile(configPath, JSON.stringify({ machines: [{ id: "slow", baseUrl: machineUrl, apiKey: "machine-key" }] }));
  const managerPort = await freePort();
  const manager = await startManager(configPath, managerPort);
  t.after(async () => {
    manager.kill("SIGTERM");
    await new Promise((resolve) => machine.close(resolve));
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${managerPort}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer client-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "opencode/big-pickle", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 12_000;
  while (!output.includes("[DONE]") && Date.now() < deadline) {
    const next = await reader.read();
    if (next.done) break;
    output += decoder.decode(next.value, { stream: true });
  }
  assert.match(output, /data: .*ok/);
  assert.match(output, /data: \[DONE\]/);
  assert.match(output, /: manager-keep-alive/);
});
