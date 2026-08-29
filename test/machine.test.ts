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
