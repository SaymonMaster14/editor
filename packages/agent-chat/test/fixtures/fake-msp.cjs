#!/usr/bin/env node
// Fake MSP server for MuseHarness tests: the validated `muse serve`
// subset (initialize, initialized, model/list, session/start|resume,
// session/setModel, turn/start|interrupt, approval/decide,
// userInput/answer|cancel). Behavior is driven by the prompt text; every
// request is appended to $FAKE_MSP_LOG for assertions.
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("Muse Code 9.9.9 (fake)");
  process.exit(0);
}

const logFile = process.env.FAKE_MSP_LOG;
const log = (line) => {
  if (logFile) fs.appendFileSync(logFile, line + "\n");
};

let buffer = "";
let initialized = false;
let pendingTurn = null;
let counter = 0;
let pendingApprovals = [];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function itemStarted(sessionId, item) {
  send({ jsonrpc: "2.0", method: "item/started", params: { sessionId, item } });
}

function itemDelta(sessionId, itemId, field, delta) {
  send({ jsonrpc: "2.0", method: "item/delta", params: { sessionId, itemId, field, delta } });
}

function itemCompleted(sessionId, item) {
  send({ jsonrpc: "2.0", method: "item/completed", params: { sessionId, item } });
}

function turnCompleted(sessionId, turnId, terminal, error) {
  send({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId, turnId, terminal, ...(error ? { error } : {}) } });
}

function finishTurn(sessionId, turnId, text) {
  const msgId = `msg_${++counter}`;
  itemStarted(sessionId, { itemId: msgId, kind: "agentMessage", turnId, revision: 1, status: "inProgress", text: "" });
  itemDelta(sessionId, msgId, "text", text);
  itemCompleted(sessionId, { itemId: msgId, kind: "agentMessage", turnId, revision: 2, status: "completed", text });
  turnCompleted(sessionId, turnId, "completed");
}

function handle(message) {
  if (typeof message.method === "string" && message.id === undefined) {
    if (message.method === "initialized") initialized = true;
    return;
  }
  if (message.id === "srv-userinput") {
    // The presentation receipt: the turn settles on userInput/answer|cancel.
    log(`userinput ${JSON.stringify(message.result ?? message.error)}`);
    return;
  }
  if (typeof message.method !== "string" || message.id === undefined) return;
  const { id, method, params } = message;
  log(`request ${method}`);
  if (method !== "initialize" && !initialized) {
    send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Not initialized", data: { kind: "notInitialized" } } });
    return;
  }
  switch (method) {
    case "initialize":
      log(`caps ${JSON.stringify((params.capabilities ?? {}).requestedCapabilities ?? null)}`);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          serverInfo: { name: "fakemuse", version: "9.9.9" },
          grantedCapabilities: (params.capabilities ?? {}).requestedCapabilities ?? [],
          experimentalApi: false,
          sessionDurability: "durable",
        },
      });
      break;
    case "model/list":
      send({ jsonrpc: "2.0", id, result: { providerId: "fake", models: [
        { modelId: "fake/a", displayLabel: "Fake A", isDefault: true },
        { modelId: "fake/b", displayLabel: "Fake B", isDefault: false },
      ] } });
      break;
    case "session/start":
      log(`mcp ${JSON.stringify((params.config ?? {}).mcpServers ?? null)}`);
      log(`approval ${params.approvalMode ?? null}`);
      send({ jsonrpc: "2.0", id, result: { session: { sessionId: "ses_test", modelId: params.modelId ?? "fake/a" }, viewCursor: "" } });
      break;
    case "session/resume":
      log(`resume ${params.sessionId}`);
      if (params.sessionId === "ses_missing") {
        send({ jsonrpc: "2.0", id, error: { code: -32030, message: "unknown session", data: { kind: "commandRejected" } } });
        break;
      }
      send({ jsonrpc: "2.0", id, result: { session: { sessionId: params.sessionId, modelId: "fake/a" }, viewCursor: "", history: { mode: "none" }, pendingRequests: [] } });
      break;
    case "session/setModel":
      log(`model ${(params.model ?? {}).modelId}`);
      send({ jsonrpc: "2.0", id, result: { commandId: params.commandId, status: "accepted" } });
      break;
    case "approval/decide":
      log(`decide ${params.approvalId} ${params.choiceId}`);
      send({ jsonrpc: "2.0", id, result: { commandId: params.commandId, status: "accepted", terminal: true } });
      break;
    case "approval/listPending":
      send({ jsonrpc: "2.0", id, result: { approvals: pendingApprovals } });
      pendingApprovals = [];
      break;
    case "userInput/answer":
      log(`answer ${JSON.stringify(params.answers)}`);
      send({ jsonrpc: "2.0", id, result: { commandId: params.commandId, status: "accepted" } });
      if (pendingTurn && pendingTurn.afterQuestion) {
        const { sessionId, turnId } = pendingTurn;
        pendingTurn = null;
        finishTurn(sessionId, turnId, "answered");
      }
      break;
    case "userInput/cancel":
      log("cancel-input");
      send({ jsonrpc: "2.0", id, result: { commandId: params.commandId, status: "accepted" } });
      if (pendingTurn && pendingTurn.afterQuestion) {
        const { sessionId, turnId } = pendingTurn;
        pendingTurn = null;
        turnCompleted(sessionId, turnId, "completed");
      }
      break;
    case "turn/start": {
      const text = (params.input ?? []).map((part) => part.text ?? "").join("\n");
      const sessionId = params.sessionId;
      const turnId = params.commandId;
      if (text.includes("INTERRUPT-ME")) {
        pendingTurn = { sessionId, turnId };
        send({ jsonrpc: "2.0", id, result: { commandId: turnId, status: "accepted", turnId, startedNewTurn: true, disposition: "started" } });
        break;
      }
      if (text.includes("ASK-QUESTION")) {
        pendingTurn = { sessionId, turnId, afterQuestion: true };
        send({ jsonrpc: "2.0", id, result: { commandId: turnId, status: "accepted", turnId, startedNewTurn: true, disposition: "started" } });
        send({
          jsonrpc: "2.0",
          id: "srv-userinput",
          method: "userInput/request",
          params: {
            userInputId: "ui_1",
            sessionId,
            toolName: "ask",
            turnId,
            questions: [
              { id: "color", header: "Color", question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }], selection: { mode: "single" } },
            ],
          },
        });
        break;
      }
      if (text.includes("ASK-APPROVAL-NOTIFY")) {
        // Notification-only delivery: no srv id, so no {} receipt is
        // possible. The host must still decide via approval/decide.
        const arg = text.split("\n")[1]?.trim() ?? "";
        send({ jsonrpc: "2.0", id, result: { commandId: turnId, status: "accepted", turnId, startedNewTurn: true, disposition: "started" } });
        send({
          jsonrpc: "2.0",
          method: "approval/requested",
          params: {
            approvalId: "ap_notify",
            sessionId,
            toolName: "edit",
            subject: { title: "Edit file", kind: "fileAccess", path: arg },
            availableChoices: [
              { choiceId: "yes", decision: "approved", label: "Allow", scope: "once" },
              { choiceId: "no", decision: "denied", label: "Deny", scope: "once" },
            ],
            currentRequirementId: { approvalId: "ap_notify", sourceIndex: 0 },
          },
        });
        setTimeout(() => finishTurn(sessionId, turnId, "notify-flow"), 200);
        break;
      }
      if (text.includes("ASK-APPROVAL-CHOICELESS")) {
        // Choices arrive late: the request carries no choices, the full
        // approval is only visible via approval/listPending.
        const arg = text.split("\n")[1]?.trim() ?? "";
        pendingTurn = { sessionId, turnId };
        send({ jsonrpc: "2.0", id, result: { commandId: turnId, status: "accepted", turnId, startedNewTurn: true, disposition: "started" } });
        pendingApprovals = [{
          approvalId: "ap_choseless",
          sessionId,
          toolName: "edit",
          subject: { title: "Edit file", kind: "fileAccess", path: arg },
          availableChoices: [
            { choiceId: "yes", decision: "approved", label: "Allow", scope: "once" },
            { choiceId: "no", decision: "denied", label: "Deny", scope: "once" },
          ],
          currentRequirementId: { approvalId: "ap_choseless", sourceIndex: 0 },
        }];
        send({
          jsonrpc: "2.0",
          id: "srv-approval",
          method: "approval/request",
          params: {
            approvalId: "ap_choseless",
            sessionId,
            toolName: "edit",
            subject: { title: "Edit file", kind: "fileAccess", path: arg },
            availableChoices: [],
            currentRequirementId: { approvalId: "ap_choseless", sourceIndex: 0 },
          },
        });
        setTimeout(() => {
          if (!pendingTurn || pendingTurn.turnId !== turnId) return;
          pendingTurn = null;
          finishTurn(sessionId, turnId, "choseless-flow");
        }, 200);
        break;
      }
      if (text.includes("ASK-APPROVAL")) {
        pendingTurn = { sessionId, turnId };
        send({ jsonrpc: "2.0", id, result: { commandId: turnId, status: "accepted", turnId, startedNewTurn: true, disposition: "started" } });
        // ASK-APPROVAL-ALLOW / ASK-APPROVAL-DENY carry the subject path on the
        // next line so policy decisions are exercised; bare ASK-APPROVAL sends
        // a pathless shell request, which must surface to the user.
        const arg = text.split("\n")[1]?.trim() ?? "";
        const withSubject = text.includes("ASK-APPROVAL-ALLOW") || text.includes("ASK-APPROVAL-DENY");
        send({
          jsonrpc: "2.0",
          id: "srv-approval",
          method: "approval/request",
          params: {
            approvalId: "ap_1",
            sessionId,
            toolName: withSubject ? "edit" : "shell",
            ...(withSubject ? { subject: { title: "Edit file", kind: "fileAccess", path: arg }, rawArgs: JSON.stringify({ file_path: arg }) } : {}),
            availableChoices: [
              { choiceId: "yes", decision: "approved", label: "Allow", scope: "once" },
              { choiceId: "no", decision: "denied", label: "Deny", scope: "once" },
            ],
            currentRequirementId: { approvalId: "ap_1", sourceIndex: 0 },
          },
        });
        setTimeout(() => {
          if (!pendingTurn || pendingTurn.turnId !== turnId) return;
          pendingTurn = null;
          finishTurn(sessionId, turnId, "approved-flow");
        }, 200);
        break;
      }
      if (text.includes("FAIL-ME")) {
        send({ jsonrpc: "2.0", id, result: { commandId: turnId, status: "accepted", turnId, startedNewTurn: true, disposition: "started" } });
        turnCompleted(sessionId, turnId, "failed", { kind: "modelError", message: "boom", retryable: false });
        break;
      }
      send({ jsonrpc: "2.0", id, result: { commandId: turnId, status: "accepted", turnId, startedNewTurn: true, disposition: "started" } });
      const msgId = `msg_${++counter}`;
      itemStarted(sessionId, { itemId: msgId, kind: "agentMessage", turnId, revision: 1, status: "inProgress", text: "" });
      itemDelta(sessionId, msgId, "text", "Hello ");
      itemDelta(sessionId, msgId, "text", "there");
      itemCompleted(sessionId, { itemId: msgId, kind: "agentMessage", turnId, revision: 2, status: "completed", text: "Hello there" });
      const toolId = `tc_${++counter}`;
      itemStarted(sessionId, { itemId: toolId, kind: "toolCall", turnId, revision: 1, status: "inProgress", tool: "read", args: JSON.stringify({ path: "a.txt" }) });
      itemCompleted(sessionId, { itemId: toolId, kind: "toolCall", turnId, revision: 2, status: "completed", tool: "read", args: JSON.stringify({ path: "a.txt" }), visibleOutput: "file contents" });
      turnCompleted(sessionId, turnId, "completed");
      break;
    }
    case "turn/interrupt":
      log("interrupt");
      if (pendingTurn && !pendingTurn.afterQuestion) {
        const { sessionId, turnId } = pendingTurn;
        pendingTurn = null;
        send({ jsonrpc: "2.0", id, result: { commandId: params.commandId, status: "accepted" } });
        turnCompleted(sessionId, turnId, "cancelled");
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32030, message: "missing_run", data: { kind: "commandRejected", reason: "missing_run" } } });
      }
      break;
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
