/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// OpenCode through `opencode acp`: the Agent Client Protocol, JSON-RPC 2.0
// over the child's stdio — the same transport as `codex app-server`, so the
// session below mirrors CodexSession turn for turn. Validated against
// OpenCode 1.18.31: `initialize` → `session/new` (or `session/load`) → set
// the model with `session/set_config_option` → `session/prompt`, streaming
// back as `session/update` notifications. The MCP server is injected per
// session, so nothing is written to the user's config.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HARNESS_LABELS } from "../protocol";
import { compareVersions, killTree, needsShell, quoteArg, resolveBinary, resolveOpencodeExecutable } from "./env";
import { JsonRpcPeer, RpcError } from "./jsonrpc";
import { QuestionBox, newItemId, summarizeInput, truncateDetail } from "./harness";

import type { ChildProcess } from "node:child_process";
import type { HarnessCapabilities, HarnessInfo, Item, Question, RequestResponse } from "../protocol";
import type { HostEnv } from "./env";
import type { Emit, Harness, HarnessSession, OpenOptions, ResumeCursor, TurnOutcome } from "./harness";

const MIN_VERSION = "1.0.0";
const PROBE_TIMEOUT_MS = 25_000;
const ACP_PROTOCOL_VERSION = 1;

const CLIENT_NAME = "diffusion_studio";

/** Shown when the probe cannot reach a server but the binary is there. */
const STATIC_MODELS = [
  { id: "opencode/big-pickle", label: "Big Pickle" },
  { id: "opencode/claude-opus-4-6", label: "Opus 4.6" },
];

// The slices of ACP we read, hand-typed from live traffic against 1.18.31.
// Everything is optional on purpose: a field a newer OpenCode renamed must
// degrade, not throw.
type AcpContentPart = { type?: string; text?: string; data?: string; mimeType?: string };
type AcpModelOption = { value?: string; name?: string };
type AcpConfigOption = { id?: string; currentValue?: string; options?: AcpModelOption[] };

type InitializeResult = {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    promptCapabilities?: { embeddedContext?: boolean; image?: boolean };
  };
  authMethods?: { id?: string; name?: string; description?: string }[];
  agentInfo?: { name?: string; version?: string };
};

type SessionResult = { sessionId?: string; configOptions?: AcpConfigOption[] };
type PromptResult = { stopReason?: string };
type SessionUpdateParams = { sessionId?: string; update?: SessionUpdate };
type SessionUpdate = {
  sessionUpdate?: string;
  messageId?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: AcpContentPart;
  rawInput?: unknown;
  rawOutput?: unknown;
};
type PermissionRequest = {
  sessionId?: string;
  toolCall?: { toolCallId?: string; title?: string; kind?: string };
  options?: { optionId?: string; name?: string; kind?: string }[];
};

type Turn = { emit: Emit; resolve(outcome: TurnOutcome): void; items: Map<string, Item> };

function modelsOf(configOptions: AcpConfigOption[] | undefined): { models: { id: string; label: string }[]; current?: string } {
  const model = (configOptions ?? []).find((option) => option.id === "model");
  const models = (model?.options ?? [])
    .filter((option) => option.value)
    .map((option) => ({ id: option.value!, label: option.name ?? option.value! }));
  return { models, current: model?.currentValue };
}

function textOf(content: AcpContentPart | undefined): string | undefined {
  return content?.type === "text" ? content.text : undefined;
}

function outputOf(update: SessionUpdate): string | undefined {
  const text = textOf(update.content);
  if (text) return text;
  if (update.rawOutput === undefined || update.rawOutput === null) return undefined;
  if (typeof update.rawOutput === "string") return update.rawOutput;
  try {
    return JSON.stringify(update.rawOutput);
  } catch {
    return String(update.rawOutput);
  }
}

function mcpServersOf(mcpUrl: string | null): unknown[] {
  // Shape verified live: `type` + `url` + `headers` array, or the probe's
  // session/new rejects the params. Unreachable URLs are accepted lazily.
  return mcpUrl ? [{ name: "diffusion", type: "http", url: mcpUrl, headers: [] }] : [];
}

/**
 * Whether any provider credentials exist. OpenCode keeps them in
 * `<data>/opencode/auth.json`; absent or empty means every prompt would
 * fail, so the picker says signed-out instead of ready.
 */
function hasAuth(host: HostEnv): boolean {
  const dataDir = host.env.XDG_DATA_HOME ?? process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const file = join(dataDir, "opencode", "auth.json");
  try {
    if (!existsSync(file)) return false;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return !!parsed && typeof parsed === "object" && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

function spawnAcpServer(binary: string, cwd: string, env: Record<string, string>): ChildProcess {
  const shell = needsShell(binary);
  const args = ["acp"];
  return spawn(shell ? `"${binary}"` : binary, shell ? args.map(quoteArg) : args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
  });
}

async function initialize(peer: JsonRpcPeer, version: string): Promise<InitializeResult> {
  return (await peer.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: CLIENT_NAME, title: "Diffusion Studio", version },
  })) as InitializeResult;
}

class OpenCodeSession implements HarnessSession {
  resume: ResumeCursor;
  private readonly child: ChildProcess;
  private readonly peer: JsonRpcPeer;
  private readonly sessionId: string;
  private currentModel: string | null;
  private turn: Turn | null = null;
  private questions: QuestionBox | null = null;
  private interrupting = false;
  private closed = false;

  constructor(child: ChildProcess, peer: JsonRpcPeer, sessionId: string, currentModel: string | null) {
    this.child = child;
    this.peer = peer;
    this.sessionId = sessionId;
    this.currentModel = currentModel;
    this.resume = { opencode: { sessionId } };
    peer.onNotification = (method, params) => this.onNotification(method, params);
    peer.onRequest = (method, params) => this.onRequest(method, params);
    peer.onClose = () => {
      this.closed = true;
      this.finish(this.interrupting ? { status: "interrupted" } : { status: "failed", error: "OpenCode exited" });
    };
  }

  static async start(options: OpenOptions, binary: string, version: string): Promise<OpenCodeSession> {
    const child = spawnAcpServer(binary, options.cwd, options.env.env);
    const peer = new JsonRpcPeer(child);
    try {
      const init = await initialize(peer, version);
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(`OpenCode speaks ACP ${init.protocolVersion ?? "unknown"}, needs ${ACP_PROTOCOL_VERSION}`);
      }
      const resumeId = options.resume && "opencode" in options.resume ? options.resume.opencode.sessionId : null;
      const { sessionId, currentModel, resumed } = await OpenCodeSession.openSession(peer, options, resumeId);
      if (!resumed && resumeId) {
        options.emit({
          type: "item.completed",
          item: { id: newItemId("n"), kind: "notice", level: "info", text: "Previous OpenCode session not found — started fresh" },
        });
      }
      return new OpenCodeSession(child, peer, sessionId, currentModel);
    } catch (error) {
      await killTree(child);
      throw error;
    }
  }

  private static async openSession(
    peer: JsonRpcPeer,
    options: OpenOptions,
    resumeId: string | null,
  ): Promise<{ sessionId: string; currentModel: string | null; resumed: boolean }> {
    const mcpServers = mcpServersOf(options.mcp?.url ?? null);
    const start = async (): Promise<{ sessionId: string; currentModel: string | null }> => {
      const result = (await peer.request("session/new", { cwd: options.cwd, mcpServers })) as SessionResult;
      if (!result.sessionId) throw new Error("OpenCode did not return a session id");
      return { sessionId: result.sessionId, currentModel: modelsOf(result.configOptions).current ?? null };
    };
    if (!resumeId) {
      const fresh = await start();
      return { ...fresh, resumed: true };
    }
    try {
      const result = (await peer.request("session/load", { sessionId: resumeId, cwd: options.cwd, mcpServers })) as SessionResult;
      // `session/load` replays history as notifications and may omit the id.
      return { sessionId: resumeId, currentModel: modelsOf(result.configOptions).current ?? null, resumed: true };
    } catch (error) {
      if (error instanceof RpcError || /not found|no such|unknown session/i.test((error as Error)?.message ?? "")) {
        const fresh = await start();
        return { ...fresh, resumed: false };
      }
      throw error;
    }
  }

  async send(text: string, model: string, emit: Emit): Promise<TurnOutcome> {
    if (this.turn) throw new Error("A turn is already running");
    if (this.closed) throw new Error("OpenCode exited");
    this.interrupting = false;
    this.questions = new QuestionBox(emit);
    return new Promise<TurnOutcome>((resolve, reject) => {
      this.turn = { emit, resolve, items: new Map() };
      void this.runTurn(text, model).catch((error: Error) => {
        this.turn = null;
        this.questions = null;
        reject(error);
      });
    });
  }

  private async runTurn(text: string, model: string): Promise<void> {
    if (model !== this.currentModel) {
      const result = (await this.peer.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "model",
        value: model,
      })) as SessionResult;
      this.currentModel = modelsOf(result.configOptions).current ?? model;
    }
    const result = (await this.peer.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    })) as PromptResult;
    const stop = result.stopReason ?? "end_turn";
    if (stop === "cancelled" || this.interrupting) this.finish({ status: "interrupted" });
    else if (stop !== "end_turn") {
      this.turn?.emit({
        type: "item.completed",
        item: { id: newItemId("n"), kind: "notice", level: "info", text: `OpenCode stopped: ${stop}` },
      });
      this.finish({ status: "completed" });
    } else this.finish({ status: "completed" });
  }

  private finish(outcome: TurnOutcome): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.questions?.cancelAll();
    this.questions = null;
    // Complete any tool or message item the server left open, so the
    // transcript never shows a spinner forever.
    for (const item of turn.items.values()) {
      if (item.kind === "tool") turn.emit({ type: "item.completed", item: { ...item, status: "done" } });
      else turn.emit({ type: "item.completed", item });
    }
    turn.resolve(outcome);
  }

  respond(requestId: string, response: RequestResponse): void {
    this.questions?.settle(requestId, response);
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    this.interrupting = true;
    this.questions?.cancelAll();
    const done = new Promise<void>((resolve) => {
      const previous = turn.resolve;
      turn.resolve = (outcome) => {
        previous(outcome);
        resolve();
      };
    });
    // `session/cancel` is a notification: no acknowledgement to await.
    this.peer.notify("session/cancel", { sessionId: this.sessionId });
    // The prompt request usually settles right after; a server that never
    // answers must not hang the chat.
    await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    this.finish({ status: "interrupted" });
  }

  async close(): Promise<void> {
    if (this.turn) await this.interrupt();
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      // Already closed.
    }
    await killTree(this.child);
  }

  // -------------------------------------------------------------------
  // Notifications and requests from the server

  private toolItem(update: SessionUpdate, completed: boolean): Item {
    const id = update.toolCallId ?? newItemId("x");
    const output = completed ? outputOf(update) : undefined;
    return {
      id,
      kind: "tool",
      name: update.kind ? `tool_${update.kind}` : "tool",
      title: update.title ?? update.kind ?? "tool",
      detail: summarizeInput(update.rawInput),
      ...(output ? { output: truncateDetail(output) } : {}),
      status: !completed ? "running" : update.status === "failed" ? "failed" : "done",
    };
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const turn = this.turn;
    const update = ((params ?? {}) as SessionUpdateParams).update ?? {};
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = textOf(update.content);
        const messageId = update.messageId;
        if (!turn || !messageId || !text) return;
        if (!turn.items.has(messageId)) {
          const item: Item =
            update.sessionUpdate === "agent_message_chunk" ? { id: messageId, kind: "assistant", text: "" } : { id: messageId, kind: "reasoning", text: "" };
          turn.items.set(messageId, item);
          turn.emit({ type: "item.started", item });
        }
        turn.emit({ type: "item.delta", itemId: messageId, text });
        return;
      }
      case "tool_call": {
        if (!turn || !update.toolCallId) return;
        const item = this.toolItem(update, false);
        turn.items.set(item.id, item);
        turn.emit({ type: "item.started", item });
        return;
      }
      case "tool_call_update": {
        if (!turn || !update.toolCallId) return;
        const done = update.status === "completed" || update.status === "failed";
        if (!turn.items.has(update.toolCallId) && !done) {
          const item = this.toolItem(update, false);
          turn.items.set(item.id, item);
          turn.emit({ type: "item.started", item });
          return;
        }
        if (!done) return;
        turn.items.delete(update.toolCallId);
        turn.emit({ type: "item.completed", item: this.toolItem(update, true) });
        return;
      }
      default:
        // user_message_chunk (our own prompt echoed), usage/config/commands
        // bookkeeping: nothing the transcript needs.
        return;
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.askPermission((params ?? {}) as PermissionRequest);
      default:
        throw new RpcError({ code: -32601, message: `Unsupported request ${method}` });
    }
  }

  private async askPermission(request: PermissionRequest): Promise<unknown> {
    const toolCallId = request.toolCall?.toolCallId ?? "permission";
    const options = request.options ?? [];
    const cancelled = { outcome: { outcome: "cancelled" } };
    const questions: Question[] = [
      {
        id: toolCallId,
        header: "Allow?",
        question: request.toolCall?.title ?? "OpenCode asks to proceed",
        options: options.map((option) => ({ label: option.name ?? option.optionId ?? "", description: option.kind ?? "" })),
        multiSelect: false,
        allowOther: false,
        secret: false,
      },
    ];
    const box = this.questions;
    if (!box || options.length === 0) return cancelled;
    const response = await box.ask(questions);
    if (response === "skip" || response === "cancel") return cancelled;
    const picked = (response.answers[toolCallId] ?? [])[0];
    const option = options.find((entry) => (entry.name ?? entry.optionId) === picked);
    if (!option?.optionId) return cancelled;
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
}

export class OpenCodeHarness implements Harness {
  readonly id = "opencode" as const;
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    images: false,
    attachments: true,
    mcp: true,
    approvals: true,
    questions: false,
    interrupt: true,
    resume: true,
    models: true,
    sessions: true,
  };
  private readonly version: string;

  constructor(version = "0.0.0") {
    this.version = version;
  }

  async probe(env: HostEnv, signal: AbortSignal): Promise<HarnessInfo> {
    const label = HARNESS_LABELS.opencode;
    const resolved = resolveBinary("opencode", env);
    if (!resolved) return { id: this.id, label, capabilities: this.capabilities, status: "not-installed", detail: "Install OpenCode, then reopen the picker", models: [] };
    const binary = resolveOpencodeExecutable(resolved);

    const child = spawnAcpServer(binary, process.cwd(), env.env);
    const peer = new JsonRpcPeer(child);
    const timer = setTimeout(() => void killTree(child), PROBE_TIMEOUT_MS);
    const onAbort = () => void killTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const init = await initialize(peer, this.version);
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
        return { id: this.id, label, capabilities: this.capabilities, status: "error", detail: `OpenCode speaks ACP ${init.protocolVersion ?? "unknown"}`, models: [] };
      }
      const version = init.agentInfo?.version;
      const outdated = version && compareVersions(version, MIN_VERSION) < 0 ? `Update OpenCode (${version} is older than ${MIN_VERSION})` : undefined;
      if (!hasAuth(env)) {
        return { id: this.id, label, capabilities: this.capabilities, status: "signed-out", detail: "Run `opencode auth login` in a terminal", version, models: [] };
      }
      const session = (await peer.request("session/new", { cwd: process.cwd(), mcpServers: [] })) as SessionResult;
      const { models, current } = modelsOf(session.configOptions);
      if (session.sessionId) {
        try {
          await peer.request("session/close", { sessionId: session.sessionId });
        } catch {
          // Older servers lack it; the empty session is harmless.
        }
      }
      return {
        id: this.id,
        label,
        capabilities: this.capabilities,
        status: "ready",
        detail: outdated,
        version,
        models: models.length ? models : STATIC_MODELS,
        defaultModel: current ?? models[0]?.id ?? STATIC_MODELS[0]!.id,
      };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      if (/log ?in|not authenticated|unauthori[sz]ed|no auth/i.test(message)) {
        return { id: this.id, label, capabilities: this.capabilities, status: "signed-out", detail: "Run `opencode auth login` in a terminal", models: [] };
      }
      return { id: this.id, label, capabilities: this.capabilities, status: "ready", detail: /exited/i.test(message) ? undefined : message, models: STATIC_MODELS, defaultModel: STATIC_MODELS[0]!.id };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void killTree(child);
    }
  }

  async open(options: OpenOptions): Promise<HarnessSession> {
    const resolved = resolveBinary("opencode", options.env);
    if (!resolved) throw new Error("OpenCode is not installed");
    return OpenCodeSession.start(options, resolveOpencodeExecutable(resolved), this.version);
  }
}
