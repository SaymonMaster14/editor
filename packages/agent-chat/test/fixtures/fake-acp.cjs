#!/usr/bin/env node
// Fake ACP server for OpenCodeHarness tests: the validated `opencode acp`
// subset (initialize, session/new|load, set_config_option, prompt, close,
// cancel, request_permission). Behavior is driven by the prompt text; every
// request is appended to $FAKE_ACP_LOG for assertions.
const fs = require("node:fs");

const logFile = process.env.FAKE_ACP_LOG;
const log = (line) => {
  if (logFile) fs.appendFileSync(logFile, line + "\n");
};

const MODEL_OPTION = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "fake/a",
  options: [
    { value: "fake/a", name: "Fake A" },
    { value: "fake/b", name: "Fake B" },
  ],
};

let buffer = "";
let pendingPrompt = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function update(sessionId, update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function handle(message) {
  if (message.method === "session/cancel") {
    log("cancel");
    if (pendingPrompt) {
      const { id } = pendingPrompt;
      pendingPrompt = null;
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
    return;
  }
  if (message.id === "srv-permission") {
    log(`permission ${JSON.stringify(message.result ?? message.error)}`);
    if (pendingPrompt && pendingPrompt.afterPermission) {
      const { id, sessionId } = pendingPrompt;
      pendingPrompt = null;
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_1",
        title: "Delete everything",
        kind: "delete",
        status: "completed",
        content: { type: "text", text: "done" },
      });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
    return;
  }
  if (typeof message.method !== "string" || message.id === undefined) return;
  const { id, method, params } = message;
  log(`request ${method}`);
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { embeddedContext: true, image: true } },
          authMethods: [],
          agentInfo: { name: "FakeCode", version: "9.9.9" },
        },
      });
      break;
    case "session/new":
      log(`mcp ${JSON.stringify(params.mcpServers ?? null)}`);
      send({ jsonrpc: "2.0", id, result: { sessionId: "ses_test", configOptions: [{ ...MODEL_OPTION }] } });
      break;
    case "session/load":
      log(`load ${params.sessionId}`);
      send({ jsonrpc: "2.0", id, result: { configOptions: [{ ...MODEL_OPTION }] } });
      break;
    case "session/set_config_option":
      log(`model ${params.value}`);
      send({ jsonrpc: "2.0", id, result: { configOptions: [{ ...MODEL_OPTION, currentValue: params.value }] } });
      break;
    case "session/close":
      send({ jsonrpc: "2.0", id, result: {} });
      break;
    case "session/prompt": {
      const text = (params.prompt ?? []).map((part) => part.text ?? "").join("\n");
      const sessionId = params.sessionId;
      if (text.includes("INTERRUPT-ME")) {
        pendingPrompt = { id, sessionId };
        break;
      }
      if (text.includes("ASK-PERMISSION")) {
        pendingPrompt = { id, sessionId, afterPermission: true };
        send({
          jsonrpc: "2.0",
          id: "srv-permission",
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "tc_1", title: "Delete everything", kind: "delete" },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        });
        break;
      }
      update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "Hello " } });
      update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "there" } });
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "read", kind: "read", status: "pending", rawInput: { path: "a.txt" } });
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_1",
        title: "read",
        kind: "read",
        status: "completed",
        rawInput: { path: "a.txt" },
        content: { type: "text", text: "file contents" },
      });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      break;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method ${method}` } });
      break;
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Ignore malformed input.
    }
  }
});
