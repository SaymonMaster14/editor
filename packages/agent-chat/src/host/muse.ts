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
import { buildPolicy, decideToolAction } from "./policy";

import type { ChildProcess } from "node:child_process";
import type { HarnessCapabilities, HarnessInfo, Item, Question, RequestResponse } from "../protocol";
import type { HostEnv } from "./env";
import type { Emit, Harness, HarnessSession, OpenOptions, ResumeCursor, TurnOutcome } from "./harness";
import type { AccessDecision, AccessPolicy } from "./policy";

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
export type MspApprovalChoice = { choiceId?: string; decision?: string; label?: string; scope?: string };
/** The approval subject union, as far as policy decisions read it: kind, path, command. */
export type MspApprovalSubject = { title?: string; detail?: string; kind?: string; path?: string; command?: string; access?: string; target?: string; toolName?: string };
export type MspApprovalRequest = {
  approvalId?: string;
  sessionId?: string;
  toolName?: string;
  rawArgs?: string;
  subject?: MspApprovalSubject;
  protectedWrite?: boolean;
  availableChoices?: MspApprovalChoice[];
  currentRequirementId?: { approvalId?: string; sourceIndex?: number };
};

/**
 * Maps Diffusion access onto Muse: `allowAll`, or `onRequest` with host-side
 * policy decisions.
 *
 * Proven live against 1.3.0: MSP does NOT gate file tools — `write_file`
 * outside the workspace lands without any approval traffic in `onRequest`,
 * `promptUnmatched`, and `denyUnmatched` alike. Only unresolved shell
 * commands surface approvals, which the host answers from the access
 * policy. So Muse honors the policy for shell, never for file writes:
 * `writeRoots` is false and the matrix documents it.
 */
export type MusePolicy = { approvalMode: "allowAll" | "onRequest"; access: AccessPolicy };

export function musePolicyFor(access: AccessPolicy | undefined, cwd: string): MusePolicy {
  const policy = access ?? buildPolicy(cwd, { mode: "project", roots: [] });
  return { approvalMode: policy.mode === "full" ? "allowAll" : "onRequest", access: policy };
}

/** Muse tool names that only read. Everything else file-shaped is checked as a write. */
const MSP_READ_TOOLS = new Set(["read", "list", "glob", "grep", "search", "cat", "show", "stat"]);

function mspInput(request: MspApprovalRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const args = parseArgs(request.rawArgs);
  if (args && typeof args === "object") Object.assign(input, args);
  const subject = request.subject ?? {};
  if (subject.path && typeof input.file_path !== "string" && typeof input.path !== "string") input.file_path = subject.path;
  if (subject.command && typeof input.command !== "string") input.command = subject.command;
  if (subject.target && typeof input.target !== "string") input.target = subject.target;
  return input;
}

/**
 * Decides one MSP approval against the access policy. In-project work is
 * silent; outside writes are denied; anything the filesystem policy has no
 * verdict for (network, unknown tools, pathless requests) goes to the user.
 */
export function decideMspApproval(policy: AccessPolicy, cwd: string, request: MspApprovalRequest): AccessDecision {
  if (policy.mode === "full") return "allow";
  const subject = request.subject ?? {};
  if (subject.kind && subject.kind !== "fileAccess" && subject.kind !== "shell" && subject.kind !== "tool") return "ask";
  const tool = (request.toolName ?? subject.toolName ?? "").toLowerCase();
  const shellish = tool === "shell" || tool === "bash" || tool === "exec" || tool === "run" || tool === "command" || subject.kind === "shell";
  if (shellish) {
    const verdict = decideToolAction(policy, cwd, "Bash", mspInput(request));
    if (verdict.decision === "allow" && verdict.paths.length === 0 && !subject.command && !subject.path) return "ask";
    return verdict.decision;
  }
  if (MSP_READ_TOOLS.has(tool)) return decideToolAction(policy, cwd, "Read", mspInput(request)).decision;
  if (subject.kind === "fileAccess" || subject.kind === "tool" || tool || subject.path) {
    const verdict = decideToolAction(policy, cwd, "Write", mspInput(request));
    if (verdict.decision === "allow" && verdict.paths.length === 0 && !subject.path) return "ask";
    return verdict.decision;
  }
  return "ask";
}
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
  private readonly policy: MusePolicy;
  private readonly cwd: string;
  private readonly sessionId: string;
  private currentModel: string | null;
  private turn: Turn | null = null;
  private questions: QuestionBox | null = null;
  private interrupting = false;
  private closed = false;
  /** Approvals already answered or resolved in the current turn, so the request + requested + updated triple delivery decides exactly once. Cleared on every turn/start: a later turn may legitimately reuse an approval id. */
  private readonly decidedApprovals = new Set<string>();

  constructor(child: ChildProcess, peer: JsonRpcPeer, policy: MusePolicy, cwd: string, sessionId: string, currentModel: string | null) {
    this.child = child;
    this.peer = peer;
    this.policy = policy;
    this.cwd = cwd;
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
    const policy = musePolicyFor(options.access, options.cwd);
    try {
      await handshake(peer, version);
      const resumeId = options.resume && "muse" in options.resume ? options.resume.muse.sessionId : null;
      const { sessionId, currentModel, resumed } = await MuseSession.openSession(peer, options, policy, resumeId);
      if (!resumed && resumeId) {
        options.emit({
          type: "item.completed",
          item: { id: newItemId("n"), kind: "notice", level: "info", text: "Previous Muse session not found — started fresh" },
        });
      }
      return new MuseSession(child, peer, policy, options.cwd, sessionId, currentModel);
    } catch (error) {
      await killTree(child);
      throw error;
    }
  }

  private static async openSession(
    peer: JsonRpcPeer,
    options: OpenOptions,
    policy: MusePolicy,
    resumeId: string | null,
  ): Promise<{ sessionId: string; currentModel: string | null; resumed: boolean }> {
    const config = { mcpServers: mcpServersOf(options.mcp?.url ?? null) };
    const start = async (): Promise<{ sessionId: string; currentModel: string | null }> => {
      const result = (await peer.request("session/start", {
        commandId: uuidv7(),
        modelId: options.model,
        workspaceRoot: options.cwd,
        approvalMode: policy.approvalMode,
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
    this.decidedApprovals.clear();
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
      case "approval/requested":
      case "approval/updated": {
        // Same payload as approval/request: the server also delivers (and
        // refreshes, e.g. when choices load late or the requirement rotates)
        // approvals as notifications. Decided ids are skipped so the triple
        // delivery answers exactly once.
        const request = (params ?? {}) as MspApprovalRequest;
        if (!request.approvalId || this.decidedApprovals.has(request.approvalId)) return;
        void this.decideApproval(request).catch((error: unknown) => this.noteApprovalError(request, error));
        return;
      }
      case "approval/resolved": {
        const resolved = ((params ?? {}) as { approvalId?: string }).approvalId;
        if (resolved) this.decidedApprovals.add(resolved);
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
      case "approval/request": {
        // The response is a presentation receipt only; the decision travels
        // as `approval/decide`, which the access policy (or the user) drives.
        // Failures surface as a chat notice: a swallowed approval error parks
        // the turn forever with zero feedback, which is what a silent catch
        // did to a live session before this notice existed.
        const request = (params ?? {}) as MspApprovalRequest;
        void this.decideApproval(request).catch((error: unknown) => this.noteApprovalError(request, error));
        return {};
      }
      case "userInput/request":
        void this.answerUserInput((params ?? {}) as MspUserInputRequest).catch(() => {});
        return {};
      default:
        throw new RpcError({ code: -32601, message: `Unsupported request ${method}` });
    }
  }

  private async decideApproval(request: MspApprovalRequest): Promise<void> {
    const approvalId = request.approvalId;
    if (!approvalId || this.decidedApprovals.has(approvalId)) return;
    let choices = request.availableChoices ?? [];
    let requirementId = request.currentRequirementId;
    if (choices.length === 0 || !requirementId) {
      // Choices can load after the request (the notification carries them):
      // refresh from the pending list instead of parking the turn silently.
      const fresh = await this.fetchPendingApproval(approvalId);
      if (fresh?.availableChoices?.length) {
        choices = fresh.availableChoices;
        requirementId = fresh.currentRequirementId ?? requirementId;
      }
    }
    if (!requirementId || choices.length === 0) {
      throw new Error("Muse asked for approval but offered no choices to answer with.");
    }
    const live: MspApprovalRequest = { ...request, availableChoices: choices, currentRequirementId: requirementId };
    const verdict = decideMspApproval(this.policy.access, this.cwd, live);
    if (verdict === "ask") {
      await this.askApproval(live, choices);
      return;
    }
    const wanted = verdict === "allow" ? "approved" : "denied";
    const pick =
      choices.find((choice) => choice.decision === wanted && choice.scope === "once") ??
      choices.find((choice) => choice.decision === wanted) ??
      (verdict === "deny" ? choices.find((choice) => choice.decision === "abort") : undefined);
    if (!pick?.choiceId) {
      // No matching choice: the user picks explicitly rather than the host guessing.
      await this.askApproval(live, choices);
      return;
    }
    await this.sendDecision(live, pick.choiceId);
  }

  private async fetchPendingApproval(approvalId: string): Promise<MspApprovalRequest | null> {
    try {
      const result = (await this.peer.request("approval/listPending", { commandId: uuidv7(), sessionId: this.sessionId })) as {
        approvals?: MspApprovalRequest[];
      };
      return (result.approvals ?? []).find((entry) => entry.approvalId === approvalId) ?? null;
    } catch {
      return null;
    }
  }

  private async sendDecision(request: MspApprovalRequest, choiceId: string, retried = false): Promise<void> {
    try {
      await this.peer.request("approval/decide", {
        approvalId: request.approvalId,
        choiceId,
        commandId: uuidv7(),
        requirementId: request.currentRequirementId,
        sessionId: request.sessionId ?? this.sessionId,
      });
      if (request.approvalId) this.decidedApprovals.add(request.approvalId);
    } catch (error) {
      // The requirement can rotate between delivery and decision (a fresh
      // approval id supersedes it): refetch once and retry with the live
      // requirement instead of leaving the turn parked.
      const stale = /stale|requirement|superseded|32053/i.test(error instanceof Error ? error.message : String(error));
      if (!retried && stale && request.approvalId) {
        const fresh = await this.fetchPendingApproval(request.approvalId);
        if (fresh?.currentRequirementId) {
          await this.sendDecision({ ...request, currentRequirementId: fresh.currentRequirementId }, choiceId, true);
          return;
        }
      }
      throw error;
    }
  }

  private noteApprovalError(request: MspApprovalRequest, error: unknown): void {
    const turn = this.turn;
    if (!turn) return;
    const what = request.toolName ?? request.subject?.title ?? "Muse approval";
    const message = error instanceof Error ? error.message : String(error);
    turn.emit({
      type: "item.completed",
      item: { id: newItemId("n"), kind: "notice", level: "error", text: `${what}: the host could not answer the approval (${message}). Interrupt the turn and retry.` },
    });
  }

  private async askApproval(request: MspApprovalRequest, choices: MspApprovalChoice[]): Promise<void> {
    const denied =
      choices.find((choice) => choice.decision === "denied" && choice.scope === "once") ??
      choices.find((choice) => choice.decision === "denied") ??
      choices.find((choice) => choice.decision === "abort");
    const box = this.questions;
    if (!box) {
      if (denied?.choiceId) await this.sendDecision(request, denied.choiceId);
      return;
    }
    const subject = request.subject ?? {};
    const what = [subject.title ?? request.toolName ?? "Muse asks to proceed", subject.path, subject.command, subject.detail]
      .filter((part): part is string => !!part)
      .join("\n");
    const response = await box.ask([
      {
        id: request.approvalId!,
        header: "Allow?",
        question: what,
        options: choices.map((choice) => ({ label: choice.label ?? choice.choiceId ?? "", description: choice.scope ?? "" })),
        multiSelect: false,
        allowOther: false,
        secret: false,
      },
    ]);
    if (response === "skip" || response === "cancel") {
      if (denied?.choiceId) await this.sendDecision(request, denied.choiceId);
      return;
    }
    const picked = response.answers[request.approvalId!]?.[0];
    const choice = choices.find((entry) => (entry.label ?? entry.choiceId) === picked) ?? denied;
    if (choice?.choiceId) await this.sendDecision(request, choice.choiceId);
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
    approvals: true,
    questions: true,
    interrupt: true,
    resume: true,
    models: true,
    sessions: true,
    // `serve` ships a shell sandbox, but it is unverified and file tools are
    // outside it entirely: the boundary is the approval layer, not a sandbox.
    sandbox: false,
    readRoots: true,
    // Proven live: MSP never gates file tools, so the host cannot scope
    // Muse file writes to roots. Shell approvals ARE policy-decided.
    writeRoots: false,
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
