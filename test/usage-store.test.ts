const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUsageStore } = require("../src/manager/usage-store.ts");

test("usage store persists totals and per-model counters in sqlite", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-usage-"));
  const dbPath = path.join(dir, "usage.sqlite");
  t.after(async () => fs.promises.rm(dir, { recursive: true, force: true }));

  const first = createUsageStore({ dbPath });
  first.record("machine-a", "opencode/free", {
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    totalTokens: 15,
  });
  const failedRequest = first.start("machine-a", "opencode/free");
  first.finish(failedRequest, null, "timeout");
  first.close();

  const second = createUsageStore({ dbPath });
  const stored = second.read("machine-a");
  assert.deepEqual({ ...stored, lastRequestAt: Boolean(stored.lastRequestAt), byModel: { "opencode/free": { ...stored.byModel["opencode/free"], lastRequestAt: Boolean(stored.byModel["opencode/free"].lastRequestAt) } } }, {
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    totalTokens: 15,
    requests: 2,
    lastRequestAt: true,
    daily: [{ day: new Date().toISOString().slice(0, 10), inputTokens: 10, outputTokens: 5, reasoningTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 15, requests: 2, lastRequestAt: stored.daily[0].lastRequestAt }],
    byModel: {
      "opencode/free": {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        totalTokens: 15,
        requests: 2,
        lastRequestAt: true,
      },
    },
  });
  assert.equal(second.listRequests({ days: 1 }).total, 2);
  assert.equal(second.listRequests({ days: 1 }).data.find((item) => item.status === "timeout")?.totalTokens, 0);
  second.close();
});
