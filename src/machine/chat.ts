"use strict";

const crypto = require("node:crypto");
const { json, sseHeaders } = require("../shared/http.ts");
const { completion, extractText, promptText, selectModel } = require("./models.ts");

function createChatHandler({ client, directory, defaultModel }) {
  async function resolveModel(name) {
    return selectModel(await client.providers(), name || defaultModel);
  }

  async function sendMessage(sessionId, payload) {
    const query = `?directory=${encodeURIComponent(directory)}`;
    return client.request(`/session/${encodeURIComponent(sessionId)}/message${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async function createSession() {
    return client.request(`/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  async function handle(req, res, body) {
    const selected = await resolveModel(body.model);
    const model = selected.name;
    const payload = {
      parts: [{ type: "text", text: promptText(body.messages) }],
      model: selected.ref,
      ...(body.temperature === undefined ? {} : { variant: String(body.temperature) }),
    };
    const id = crypto.randomBytes(12).toString("hex");

    if (!body.stream) {
      const session = await createSession();
      const message = await sendMessage(session.id, payload);
      return json(res, 200, completion(id, model, extractText(message), message?.info?.tokens?.input || 0, message?.info?.tokens?.output || 0));
    }

    res.writeHead(200, sseHeaders());
    res.flushHeaders?.();
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 5_000);
    const eventController = new AbortController();
    let sessionId = "";
    let sentRole = false;
    let streamedText = "";
    const sendDelta = (text) => {
      if (!text || res.writableEnded) return;
      streamedText += text;
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
    const eventStream = client.subscribeEvents(eventController.signal, (event) => {
      const properties = event?.properties;
      if (sessionId && properties?.sessionID === sessionId && event.type === "message.part.delta" && properties.field === "text") {
        sendDelta(String(properties.delta || ""));
      }
    });

    try {
      await eventStream.ready;
      const session = await createSession();
      sessionId = session.id;
      const message = await sendMessage(session.id, payload);
      if (!streamedText) sendDelta(extractText(message));
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${id}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) {
      const message = error?.data?.message || error?.message || "upstream error";
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`);
        res.end("data: [DONE]\n\n");
      }
    } finally {
      eventController.abort();
      clearInterval(heartbeat);
    }
  }

  return { handle, resolveModel };
}

module.exports = { createChatHandler };
