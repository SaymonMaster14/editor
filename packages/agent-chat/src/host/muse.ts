/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Muse Code through `muse serve`: the Muse Session Protocol, JSON-RPC 2.0
// over the child's stdio — the same transport as `codex app-server` and
// `opencode acp`, so the session below mirrors those turn for turn.
// Validated against Muse Code 1.3.0: `initialize` → `initialized` →
// `session/start` (or `session/resume`) → `turn/start`, streaming back as
// `item/*` view notifications until `turn/completed`. The MCP server is
// injected per session, so nothing is written to the user's config.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HARNESS_LABELS } from "../protocol";
import { compareVersions, envGet, killTree, needsShell, parseVersion, quoteArg, resolveBinary, resolveMuseExecutable, runOnce } from "./env";
import { JsonRpcPeer, RpcError } from "./jsonrpc";
import { QuestionBox, newItemId, summarizeInput, toolTitle, truncateDetail } from "./harness";

import type { ChildProcess } from "node:child_process";
import type { HarnessCapabilities, HarnessInfo, Item, Question, RequestResponse } from "../protocol";
import type { HostEnv } from "./env";
import type { Emit, Harness, HarnessSession, OpenOptions, ResumeCursor, TurnOutcome } from "./harness";

const MIN_VERSION = "1.0.0";
const PROBE_TIMEOUT_MS = 30_000;

const CLIENT_NAME = "diffusion_studio";

/** Shown when the probe cannot reach a server but the binary is there. */
const STATIC_MODELS = [
  { id: "muse-spark-1.3", label: "muse-spark-1.3" },
  { id: "muse-spark-1.2", label: "muse-spark-1.2" },
];

// The slices of MSP we read, hand-typed from live traffic against 1.3.0 plus
// the `muse schema` export. Everything is optional on purpose: a field a
// newer muse renamed must degrade, not throw.
type MspModelEntry = { modelId?: string; displayLabel?: string; isDefault?: boolean };
type MspModelList = { models?: MspModelEntry[] };
type MspSession = { sessionId?: string; modelId?: string | null };
type MspSessionStart = { session?: MspSession };
type MspTurnStart = { turnId?: string };
type MspItem = {
  itemId?: string;
  kind?: string;
  status?: string;
  text?: string;
  tool?: string;
  args?: string;
  visibleOutput?: string;
  failureReason?: string;
  fallbackText?: string;
};
type MspItemParams = { sessionId?: string; itemId?: string; item?: MspItem; field?: string; delta?: string };
type MspTurnCompleted = { turnId?: string; terminal?: string; error?: { message?: string }; reason?: string };
type MspApprovalChoice = { choiceId?: string; decision?: string; label?: string; scope?: string };
type MspApprovalRequest = {
  approvalId?: string;
  sessionId?: string;
  toolName?: string;
  subject?: { title?: string; detail?: string };
  availableChoices?: MspApprovalChoice[];
  currentRequirementId?: { approvalId?: string; sourceIndex?: number };
};
type MspUserInputOption = { label?: string; description?: string };
type MspUserInputQuestion = {
  id?: string;
  header?: string;
  question?: string;
  options?: MspUserInputOption[];
  selection?: { mode?: string };
};
type MspUserInputRequest = { userInputId?: string; sessionId?: string; toolName?: string; questions?: MspUserInputQuestion[] };

type Turn = { emit: Emit; resolve(outcome: TurnOutcome): void; turnId: string | null; items: Map<string, Item> };

/**
 * UUIDv7: MSP requires it for every command id and rejects v4
 * (`invalid session/start commandId: expected UUIDv7`).
 */
export function uuidv7(): string {
  const now = BigInt(Date.now());
  const rand = randomBytes(10);
  const bytes = Buffer.alloc(16);
  bytes.writeBigUInt64BE(((now << 16n) | (BigInt(rand[0]!) << 8n) | BigInt(rand[1]!)) & 0xffffffffffffffffn, 0);
  rand.copy(bytes, 6, 2);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function modelsOf(list: MspModelList): { models: { id: string; label: string }[]; current?: string } {
  const models = (list.models ?? [])
    .filter((entry) => entry.modelId)
    .map((entry) => ({ id: entry.modelId!, label: entry.displayLabel ?? entry.modelId! }));
  const current = (list.models ?? []).find((entry) => entry.isDefault)?.modelId;
  return { models, current };
}

function mcpServersOf(mcpUrl: string | null): Record<string, unknown> | undefined {
  // Shape verified live: per-session streamableHttp injection, accepted even
  // with an unreachable URL in `optional` mode.
  if (!mcpUrl) return undefined;
  return { diffusion: { transport: "streamableHttp", url: mcpUrl, mode: "optional" } };
}

/**
 * Whether any provider credentials exist. Muse keeps them in
 * `<config>/muse/auth.json` (`MUSE_AUTH_PATH` overrides); absent or empty
 * means every model turn would fail, so the picker says signed-out.
 */
function hasAuth(host: HostEnv): boolean {
  const override = envGet(host.env, "MUSE_AUTH_PATH") ?? process.env.MUSE_AUTH_PATH;
  const configHome =
    envGet(host.env, "XDG_CONFIG_HOME") ??
    process.env.XDG_CONFIG_HOME ??
    join(envGet(host.env, "USERPROFILE") ?? process.env.USERPROFILE ?? homedir(), ".config");
  const file = override ?? join(configHome, "muse", "auth.json");
  try {
    if (!existsSync(file)) return false;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { providers?: Record<string, { access_token?: string; token?: string }> };
    const providers = parsed?.providers ?? {};
    return Object.values(providers).some((entry) => !!(entry?.access_token ?? entry?.token));
  } catch {
    return false;
  }
}

function spawnMspServer(binary: string, cwd: string, env: Record<string, string>): ChildProcess {
  const shell = needsShell(binary);
  const args = ["serve"];
  return spawn(shell ? `"${binary}"` : binary, shell ? args.map(quoteArg) : args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
  });
}

async function handshake(peer: JsonRpcPeer, version: string): Promise<void> {
  // `sessionMcp` so per-session MCP injection is granted; the `initialized`
  // notification closes the handshake — without it every call answers
  // `notInitialized`.
  await peer.request("initialize", {
    clientInfo: { name: CLIENT_NAME, title: "Diffusion Studio", version },
    capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: true },
  });
  peer.notify("initialized", {});
}

function parseArgs(args: string | undefined): unknown {
  if (!args) return undefined;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

class MuseSession implements HarnessSession {
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
    this.resume = { muse: { sessionId } };
    peer.onNotification = (method, params) => this.onNotification(method, params);
    peer.onRequest = (method, params) => this.onRequest(method, params);
    peer.onClose = () => {
      this.closed = true;
      this.finish(this.interrupting ? { status: "interrupted" } : { status: "failed", error: "Muse exited" });
    };
  }

  static async start(options: OpenOptions, binary: string, version: string): Promise<MuseSession> {
    const child = spawnMspServer(binary, options.cwd, options.env.env);
    const peer = new JsonRpcPeer(child);
    try {
      await handshake(peer, version);
      const resumeId = options.resume && "muse" in options.resume ? options.resume.muse.sessionId : null;
      const { sessionId, currentModel, resumed } = await MuseSession.openSession(peer, options, resumeId);
      if (!resumed && resumeId) {
        options.emit({
          type: "item.completed",
          item: { id: newItemId("n"), kind: "notice", level: "info", text: "Previous Muse session not found — started fresh" },
        });
      }
      return new MuseSession(child, peer, sessionId, currentModel);
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
    const config = { mcpServers: mcpServersOf(options.mcp?.url ?? null) };
    const start = async (): Promise<{ sessionId: string; currentModel: string | null }> => {
      const result = (await peer.request("session/start", {
        commandId: uuidv7(),
        modelId: options.model,
        workspaceRoot: options.cwd,
        approvalMode: "allowAll",
        config,
      })) as MspSessionStart;
      if (!result.session?.sessionId) throw new Error("Muse did not return a session id");
      return { sessionId: result.session.sessionId, currentModel: result.session.modelId ?? options.model };
    };
    if (!resumeId) {
      const fresh = await start();
      return { ...fresh, resumed: true };
    }
    try {
      const result = (await peer.request("session/resume", { commandId: uuidv7(), sessionId: resumeId, config, excludeItems: true })) as MspSessionStart & {
        pendingRequests?: unknown[];
      };
      void result.pendingRequests;
      return { sessionId: resumeId, currentModel: result.session?.modelId ?? options.model, resumed: true };
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
    if (this.closed) throw new Error("Muse exited");
    this.interrupting = false;
    this.questions = new QuestionBox(emit);
    return new Promise<TurnOutcome>((resolve, reject) => {
      this.turn = { emit, resolve, turnId: null, items: new Map() };
      void this.runTurn(text, model).catch((error: Error) => {
        this.turn = null;
        this.questions = null;
        reject(error);
      });
    });
  }

  private async runTurn(text: string, model: string): Promise<void> {
    if (model !== this.currentModel) {
      await this.peer.request("session/setModel", { commandId: uuidv7(), sessionId: this.sessionId, model: { modelId: model } });
      this.currentModel = model;
    }
    const result = (await this.peer.request("turn/start", {
      commandId: uuidv7(),
      sessionId: this.sessionId,
      input: [{ type: "text", text }],
    })) as MspTurnStart;
    // The ack only admits the turn; `turn/completed` settles it.
    if (this.turn) this.turn.turnId = result.turnId ?? null;
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
    try {
      await this.peer.request("turn/interrupt", { commandId: uuidv7(), sessionId: this.sessionId });
    } catch (error) {
      // No running turn (already finished between the check and the call):
      // that is the state we wanted anyway.
      if (!(error instanceof RpcError) || !/missing_run/.test(error.message)) throw error;
    }
    // `turn/completed` usually settles right after; a server that never
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

  private toolItem(item: MspItem, completed: boolean): Item {
    const name = item.tool ?? "tool";
    const output = completed ? item.visibleOutput : undefined;
    return {
      id: item.itemId ?? newItemId("x"),
      kind: "tool",
      name: toolTitle(name),
      title: item.fallbackText ?? name,
      detail: summarizeInput(parseArgs(item.args)),
      ...(output ? { output: truncateDetail(output) } : {}),
      status: !completed ? "running" : item.status === "failed" ? "failed" : "done",
    };
  }

  private track(item: Item, emit: Emit): void {
    const turn = this.turn;
    if (!turn || turn.items.has(item.id)) return;
    turn.items.set(item.id, item);
    emit({ type: "item.started", item });
  }

  private onNotification(method: string, params: unknown): void {
    const turn = this.turn;
    switch (method) {
      case "item/started": {
        if (!turn) return;
        const item = ((params ?? {}) as MspItemParams).item;
        if (!item?.itemId) return;
        if (item.kind === "agentMessage") this.track({ id: item.itemId, kind: "assistant", text: "" }, turn.emit);
        else if (item.kind === "reasoning") this.track({ id: item.itemId, kind: "reasoning", text: "" }, turn.emit);
        else if (item.kind === "toolCall") this.track(this.toolItem(item, false), turn.emit);
        // userMessage (our own prompt echoed), userShell, subagent,
        // workflow, reminderChild, compaction: nothing the transcript needs.
        return;
      }
      case "item/delta": {
        if (!turn) return;
        const { itemId, field, delta } = (params ?? {}) as MspItemParams;
        if (!itemId || !delta) return;
        const open = turn.items.get(itemId);
        if (!open) return;
        if ((open.kind === "assistant" && (!field || field === "text")) || (open.kind === "reasoning" && (!field || field.startsWith("summary")))) {
          turn.emit({ type: "item.delta", itemId, text: delta });
        }
        // Tool `output` deltas: the completed item carries the full text.
        return;
      }
      case "item/updated": {
        if (!turn) return;
        const item = ((params ?? {}) as MspItemParams).item;
        if (!item?.itemId) return;
        const open = turn.items.get(item.itemId);
        if (open && open.kind === "tool" && item.kind === "toolCall") {
          turn.items.set(item.itemId, this.toolItem(item, false));
        }
        return;
      }
      case "item/completed": {
        if (!turn) return;
        const item = ((params ?? {}) as MspItemParams).item;
        if (!item?.itemId) return;
        turn.items.delete(item.itemId);
        if (item.kind === "agentMessage") turn.emit({ type: "item.completed", item: { id: item.itemId, kind: "assistant", text: item.text ?? "" } });
        else if (item.kind === "reasoning") turn.emit({ type: "item.completed", item: { id: item.itemId, kind: "reasoning", text: item.text ?? "" } });
        else if (item.kind === "toolCall") turn.emit({ type: "item.completed", item: this.toolItem(item, true) });
        return;
      }
      case "turn/completed": {
        if (!turn) return;
        const completed = (params ?? {}) as MspTurnCompleted;
        if (turn.turnId && completed.turnId !== turn.turnId) return;
        if (this.interrupting || completed.terminal === "cancelled") this.finish({ status: "interrupted" });
        else if (completed.terminal === "failed") {
          this.finish({ status: "failed", error: completed.error?.message ?? completed.reason ?? "Muse turn failed" });
        } else this.finish({ status: "completed" });
        return;
      }
      default:
        // turn/started, approval/requested|resolved|updated,
        // userInput/requested|settled, session/*, usage/*, view/*: the
        // must-answer requests (below) carry the approval/question flow, and
        // usage/token events are bookkeeping the transcript skips.
        return;
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "approval/request":
        // The response is a presentation receipt only; the decision travels
        // as `approval/decide`. Never expected with approvalMode "allowAll";
        // approved at once so nothing hangs.
        void this.decideApproval((params ?? {}) as MspApprovalRequest).catch(() => {});
        return {};
      case "userInput/request":
        void this.answerUserInput((params ?? {}) as MspUserInputRequest).catch(() => {});
        return {};
      default:
        throw new RpcError({ code: -32601, message: `Unsupported request ${method}` });
    }
  }

  private async decideApproval(request: MspApprovalRequest): Promise<void> {
    const choices = request.availableChoices ?? [];
    const approved = choices.find((choice) => choice.decision === "approved" && choice.scope === "once") ?? choices.find((choice) => choice.decision === "approved") ?? choices[0];
    if (!request.approvalId || !approved?.choiceId || !request.currentRequirementId) return;
    await this.peer.request("approval/decide", {
      approvalId: request.approvalId,
      choiceId: approved.choiceId,
      commandId: uuidv7(),
      requirementId: request.currentRequirementId,
      sessionId: request.sessionId ?? this.sessionId,
    });
  }

  private async answerUserInput(request: MspUserInputRequest): Promise<void> {
    const box = this.questions;
    const userInputId = request.userInputId;
    const sessionId = request.sessionId ?? this.sessionId;
    const cancel = async (): Promise<void> => {
      if (!userInputId) return;
      await this.peer.request("userInput/cancel", { commandId: uuidv7(), sessionId, userInputId, reason: "declined" });
    };
    const raw = request.questions ?? [];
    if (!box || !userInputId || raw.length === 0) {
      await cancel();
      return;
    }
    const questions: Question[] = raw.map((entry, index) => ({
      id: entry.id ?? String(index),
      header: (entry.header ?? request.toolName ?? "Muse").slice(0, 12),
      question: entry.question ?? "",
      options: (entry.options ?? []).map((option) => ({ label: option.label ?? "", description: option.description ?? "" })),
      multiSelect: entry.selection?.mode === "multiple",
      allowOther: true,
      secret: false,
    }));
    const response = await box.ask(questions);
    if (response === "skip" || response === "cancel") {
      await cancel();
      return;
    }
    const answers = questions.map((question, index) => {
      const picked = response.answers[question.id] ?? [];
      const labels = new Set((raw[index]?.options ?? []).map((option) => option.label));
      if (question.multiSelect) return { questionId: question.id, selectedLabels: picked };
      const first = picked[0];
      if (first === undefined) return { questionId: question.id, selectedLabels: [] as string[] };
      return labels.has(first) ? { questionId: question.id, selectedLabel: first } : { questionId: question.id, freeText: first.slice(0, 500) };
    });
    await this.peer.request("userInput/answer", { commandId: uuidv7(), sessionId, userInputId, answers });
  }
}

export class MuseHarness implements Harness {
  readonly id = "muse" as const;
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    images: false,
    attachments: true,
    mcp: true,
    approvals: false,
    questions: true,
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
    const label = HARNESS_LABELS.muse;
    const resolved = resolveBinary("muse", env);
    if (!resolved) return { id: this.id, label, capabilities: this.capabilities, status: "not-installed", detail: "Install Muse Code, then reopen the picker", models: [] };
    const binary = resolveMuseExecutable(resolved);

    const child = spawnMspServer(binary, process.cwd(), env.env);
    const peer = new JsonRpcPeer(child);
    const timer = setTimeout(() => void killTree(child), PROBE_TIMEOUT_MS);
    const onAbort = () => void killTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const rawVersion = await runOnce(binary, ["--version"], env);
      const version = parseVersion(rawVersion);
      const outdated = version && compareVersions(version, MIN_VERSION) < 0 ? `Update Muse Code (${version} is older than ${MIN_VERSION})` : undefined;
      if (!hasAuth(env)) {
        return { id: this.id, label, capabilities: this.capabilities, status: "signed-out", detail: "Run `muse login` in a terminal", version, models: [] };
      }
      await handshake(peer, this.version);
      const list = (await peer.request("model/list", {})) as MspModelList;
      const { models, current } = modelsOf(list);
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
      if (/log ?in|not authenticated|unauthori[sz]ed|no auth|authRequired/i.test(message)) {
        return { id: this.id, label, capabilities: this.capabilities, status: "signed-out", detail: "Run `muse login` in a terminal", models: [] };
      }
      return { id: this.id, label, capabilities: this.capabilities, status: "ready", detail: /exited/i.test(message) ? undefined : message, models: STATIC_MODELS, defaultModel: STATIC_MODELS[0]!.id };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void killTree(child);
    }
  }

  async open(options: OpenOptions): Promise<HarnessSession> {
    const resolved = resolveBinary("muse", options.env);
    if (!resolved) throw new Error("Muse Code is not installed");
    return MuseSession.start(options, resolveMuseExecutable(resolved), this.version);
  }
}
