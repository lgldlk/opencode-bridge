"use strict";

function selectModel(catalog, requested = "") {
  if (requested && requested.includes("/")) {
    const slash = requested.indexOf("/");
    return {
      name: requested,
      ref: { providerID: requested.slice(0, slash), modelID: requested.slice(slash + 1) },
    };
  }

  const providers = catalog.all || [];
  if (requested) {
    const provider = providers.find((item) => item.id === requested);
    if (!provider) throw Object.assign(new Error(`Unknown provider: ${requested}`), { status: 400 });
    const modelID = catalog.default?.[requested] || Object.keys(provider.models || {})[0];
    if (!modelID) throw Object.assign(new Error(`Provider has no models: ${requested}`), { status: 503 });
    return { name: `${requested}/${modelID}`, ref: { providerID: requested, modelID } };
  }

  for (const [providerID, modelID] of Object.entries(catalog.default || {})) {
    const provider = providers.find((item) => item.id === providerID);
    if (provider && modelID && provider.models?.[String(modelID)]) {
      return { name: `${providerID}/${String(modelID)}`, ref: { providerID, modelID: String(modelID) } };
    }
  }

  const fallback = providers.find((provider) => Object.keys(provider.models || {}).length > 0);
  if (fallback) {
    const modelID = Object.keys(fallback.models || {})[0];
    return { name: `${fallback.id}/${modelID}`, ref: { providerID: fallback.id, modelID } };
  }
  throw Object.assign(new Error("OpenCode provider catalog has no models"), { status: 503 });
}

function catalogModelIds(catalog) {
  const connected = new Set(catalog.connected || []);
  return (catalog.all || [])
    .filter((provider) => connected.size === 0 || connected.has(provider.id))
    .flatMap((provider) => Object.keys(provider.models || {}).map((id) => `${provider.id}/${id}`));
}

function promptText(messages) {
  return (messages || []).map((message) => {
    const role = message.role || "user";
    const content = Array.isArray(message.content)
      ? message.content.map((part) => typeof part === "string" ? part : (part.text || "")).join("\n")
      : String(message.content ?? "");
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => {
        const name = call?.function?.name || call?.name || "unknown";
        const args = call?.function?.arguments ?? call?.arguments ?? "{}";
        return `${name}(${typeof args === "string" ? args : JSON.stringify(args)})`;
      }).join("\n")
      : "";
    if (role === "tool") {
      return `TOOL RESULT${message.name ? ` ${message.name}` : ""}${message.tool_call_id ? ` [${message.tool_call_id}]` : ""}:\n${content}`;
    }
    return `${role.toUpperCase()}:${toolCalls ? `\nTOOL CALLS:\n${toolCalls}` : ""}${content ? `\n${content}` : ""}`;
  }).join("\n\n");
}

function extractText(message) {
  return (message?.parts || [])
    .filter((part) => part && part.type === "text")
    .map((part) => part.text || "")
    .join("");
}

function completion(id, model, text, promptTokens = 0, completionTokens = 0) {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

module.exports = { catalogModelIds, completion, extractText, promptText, selectModel };
