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
