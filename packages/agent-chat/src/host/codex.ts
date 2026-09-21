/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Codex through `codex app-server`: JSON-RPC over the child's stdio. The
// protocol is hand-typed here for the dozen methods and notifications we
// use; anything else is ignored. The MCP server is injected with a `-c`
// override so nothing is written to the user's config.

import { spawn } from "node:child_process";

import { HARNESS_LABELS } from "../protocol";
import { compareVersions, killTree, needsShell, parseVersion, quoteArg, resolveBinary } from "./env";
import { JsonRpcPeer, RpcError } from "./jsonrpc";
import { QuestionBox, newItemId, summarizeInput, truncateDetail } from "./harness";

import type { ChildProcess } from "node:child_process";
import type { HarnessCapabilities, HarnessInfo, Item, Question, RequestResponse } from "../protocol";
import type { HostEnv } from "./env";
import type { Emit, Harness, HarnessSession, OpenOptions, ResumeCursor, TurnOutcome } from "./harness";

const MIN_VERSION = "0.100.0";
const PROBE_TIMEOUT_MS = 15_000;

const STATIC_MODELS = [
  { id: "gpt-6-astra", label: "GPT-6-Astra" },
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
];

const CLIENT_NAME = "diffusion_studio";

// The slices of the app-server protocol we read. Everything is optional on
// purpose: a field a newer Codex renamed must degrade, not throw.
type ThreadItem = {
  id?: string;
  type?: string;
  text?: string;
  summary?: string[] | string;
  content?: unknown;
  command?: string | string[];
  status?: string;
  aggregatedOutput?: string;
  exitCode?: number | null;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | string | null;
  query?: string;
  message?: string;
};

type ItemNotification = { threadId?: string; turnId?: string; item?: ThreadItem };
type DeltaNotification = { threadId?: string; turnId?: string; itemId?: string; delta?: string };
type TurnCompleted = { threadId?: string; turn?: { id?: string; status?: string; error?: { message?: string } | string | null } };
type ErrorNotification = { threadId?: string; turnId?: string; error?: { message?: string } | string; willRetry?: boolean };
type UserInputRequest = {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  questions?: { id?: string; header?: string; question?: string; isOther?: boolean; isSecret?: boolean; options?: { label?: string; description?: string }[] | null }[];
};

const errorText = (error: { message?: string } | string | null | undefined): string | undefined =>
  typeof error === "string" ? error : error?.message;

/** How the policy is spelled on every call: full access, or the sandbox when an admin said no (§5.4). */
type Policy = { full: boolean };

function threadIdOf(result: unknown): string | null {
  const record = (result ?? {}) as { thread?: { id?: string }; threadId?: string; id?: string };
  return record.thread?.id ?? record.threadId ?? record.id ?? null;
}

function spawnAppServer(binary: string, cwd: string, env: Record<string, string>, mcpUrl: string | null): ChildProcess {
  const args = ["app-server", "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false"];
  if (mcpUrl) args.push("-c", `mcp_servers.diffusion.url="${mcpUrl}"`);
  const shell = needsShell(binary);
  return spawn(shell ? `"${binary}"` : binary, shell ? args.map(quoteArg) : args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell,
    windowsHide: true,
  });
}

async function initialize(peer: JsonRpcPeer, version: string): Promise<{ version?: string }> {
  const result = (await peer.request("initialize", {
    clientInfo: { name: CLIENT_NAME, title: "Diffusion Studio", version },
    capabilities: { experimentalApi: true },
  })) as { userAgent?: string };
  peer.notify("initialized");
  return { version: parseVersion(result.userAgent ?? null) };
}

type Turn = { id: string | null; emit: Emit; resolve(outcome: TurnOutcome): void; items: Map<string, Item> };

class CodexSession implements HarnessSession {
  resume: ResumeCursor;
  private readonly policy: Policy;
  private readonly child: ChildProcess;
  private readonly peer: JsonRpcPeer;
  private threadId: string;
  private turn: Turn | null = null;
  private questions: QuestionBox | null = null;
  private interrupting = false;
  private closed = false;

  constructor(policy: Policy, child: ChildProcess, peer: JsonRpcPeer, threadId: string) {
    this.policy = policy;
    this.child = child;
    this.peer = peer;
    this.threadId = threadId;
    this.resume = { codex: { threadId } };
    peer.onNotification = (method, params) => this.onNotification(method, params);
    peer.onRequest = (method, params) => this.onRequest(method, params);
    peer.onClose = () => {
      this.closed = true;
      this.finish(this.interrupting ? { status: "interrupted" } : { status: "failed", error: "Codex exited" });
    };
  }

  static async start(options: OpenOptions, policy: Policy, binary: string, version: string): Promise<CodexSession> {
    const child = spawnAppServer(binary, options.cwd, options.env.env, options.mcp?.url ?? null);
    const peer = new JsonRpcPeer(child);
    try {
      await initialize(peer, version);
      const resumeId = options.resume && "codex" in options.resume ? options.resume.codex.threadId : null;
      const threadId = await CodexSession.openThread(peer, options, policy, resumeId);
      return new CodexSession(policy, child, peer, threadId);
    } catch (error) {
      await killTree(child);
      throw error;
    }
  }

  private static threadParams(options: OpenOptions, policy: Policy, model: string) {
    return {
      cwd: options.cwd,
      model,
      approvalPolicy: "never",
      sandbox: policy.full ? "danger-full-access" : "workspace-write",
      developerInstructions: options.instructions,
    };
  }

  private static async openThread(peer: JsonRpcPeer, options: OpenOptions, policy: Policy, resumeId: string | null): Promise<string> {
    const start = async (): Promise<string> => {
      try {
        const id = threadIdOf(await peer.request("thread/start", CodexSession.threadParams(options, policy, options.model)));
        if (!id) throw new Error("Codex did not return a thread id");
        return id;
      } catch (error) {
        // An admin that forbids full access: fall back to the sandbox, once.
        if (policy.full && error instanceof RpcError && /sandbox|approval|danger|policy|not allowed|forbidden/i.test(error.message)) {
          policy.full = false;
          options.emit({
            type: "item.completed",
            item: { id: newItemId("n"), kind: "notice", level: "info", text: "Your organization doesn't allow full access. Some actions will be blocked." },
          });
          const id = threadIdOf(await peer.request("thread/start", CodexSession.threadParams(options, policy, options.model)));
          if (!id) throw new Error("Codex did not return a thread id");
          return id;
        }
        throw error;
      }
    };
    if (!resumeId) return start();
    try {
      const id = threadIdOf(await peer.request("thread/resume", { threadId: resumeId, ...CodexSession.threadParams(options, policy, options.model) }));
      if (id) return id;
    } catch (error) {
      if (!(error instanceof RpcError) && !/not found|no such|unknown thread/i.test((error as Error)?.message ?? "")) throw error;
    }
    options.emit({
      type: "item.completed",
      item: { id: newItemId("n"), kind: "notice", level: "info", text: "Previous Codex session not found — started fresh" },
    });
    return start();
  }

  async send(text: string, model: string, emit: Emit): Promise<TurnOutcome> {
    if (this.turn) throw new Error("A turn is already running");
    if (this.closed) throw new Error("Codex exited");
    this.interrupting = false;
    this.questions = new QuestionBox(emit);
    return new Promise<TurnOutcome>((resolve, reject) => {
      this.turn = { id: null, emit, resolve, items: new Map() };
      this.peer
        .request("turn/start", {
          threadId: this.threadId,
          input: [{ type: "text", text }],
          model,
          approvalPolicy: "never",
          sandboxPolicy: this.policy.full ? { type: "dangerFullAccess" } : { type: "workspaceWrite" },
        })
        .then((result) => {
          const record = (result ?? {}) as { turn?: { id?: string }; turnId?: string };
          if (this.turn) this.turn.id ??= record.turn?.id ?? record.turnId ?? null;
        })
        .catch((error: Error) => {
          this.turn = null;
          this.questions = null;
          reject(error);
        });
    });
  }

  private finish(outcome: TurnOutcome): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.questions?.cancelAll();
    this.questions = null;
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
      await this.peer.request("turn/interrupt", { threadId: this.threadId, turnId: turn.id });
    } catch {
      // The child is gone or never got the turn: finish it ourselves.
      this.finish({ status: "interrupted" });
    }
    // The server acknowledges with `turn/completed{interrupted}`; a Codex
    // that never sends it must not hang the chat.
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

  private toItem(raw: ThreadItem, completed: boolean): Item | null {
    const id = raw.id ?? newItemId("x");
    switch (raw.type) {
      case "agentMessage":
        return { id, kind: "assistant", text: raw.text ?? "" };
      case "reasoning": {
        const summary = Array.isArray(raw.summary) ? raw.summary.join("\n") : (raw.summary ?? "");
        const content = Array.isArray(raw.content) ? (raw.content as unknown[]).filter((part) => typeof part === "string").join("\n") : "";
        return { id, kind: "reasoning", text: summary || content || (raw.text ?? "") };
      }
      case "commandExecution": {
        const command = Array.isArray(raw.command) ? raw.command.join(" ") : (raw.command ?? "");
        return {
          id,
          kind: "tool",
          name: "commandExecution",
          title: "Run",
          detail: summarizeInput(command),
          ...(raw.aggregatedOutput ? { output: truncateDetail(raw.aggregatedOutput) } : {}),
          status: !completed ? "running" : raw.status === "failed" || (typeof raw.exitCode === "number" && raw.exitCode !== 0) ? "failed" : "done",
        };
      }
      case "fileChange": {
        const paths = (raw.changes ?? []).map((change) => change.path).filter((path): path is string => !!path);
        return {
          id,
          kind: "tool",
          name: "fileChange",
          title: "Edit",
          detail: paths.length ? summarizeInput(paths.join(", ")) : undefined,
          status: !completed ? "running" : raw.status === "failed" || raw.status === "declined" ? "failed" : "done",
        };
      }
      case "mcpToolCall": {
        const resultText = raw.error ? errorText(raw.error) : raw.result !== undefined ? safeStringify(raw.result) : undefined;
        return {
          id,
          kind: "tool",
          name: `mcp__${raw.server ?? "mcp"}__${raw.tool ?? "tool"}`,
          title: raw.tool ?? "tool",
          detail: summarizeInput(raw.arguments),
          ...(resultText ? { output: truncateDetail(resultText) } : {}),
          status: !completed ? "running" : raw.error || raw.status === "failed" ? "failed" : "done",
        };
      }
      case "webSearch":
        return { id, kind: "tool", name: "webSearch", title: "Search", detail: raw.query, status: completed ? "done" : "running" };
      case "error":
        return { id, kind: "notice", level: "error", text: raw.message ?? errorText(raw.error) ?? "Codex reported an error" };
      default:
        return null;
    }
  }

  private onNotification(method: string, params: unknown): void {
    const turn = this.turn;
    switch (method) {
      case "item/started": {
        const item = turn && this.toItem(((params ?? {}) as ItemNotification).item ?? {}, false);
        if (!turn || !item) return;
        turn.items.set(item.id, item);
        turn.emit({ type: "item.started", item });
        return;
      }
      case "item/completed": {
        const item = turn && this.toItem(((params ?? {}) as ItemNotification).item ?? {}, true);
        if (!turn || !item) return;
        turn.items.delete(item.id);
        turn.emit({ type: "item.completed", item });
        return;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const { itemId, delta } = (params ?? {}) as DeltaNotification;
        if (!turn || !itemId || !delta) return;
        if (!turn.items.has(itemId)) {
          const item: Item = method === "item/agentMessage/delta" ? { id: itemId, kind: "assistant", text: "" } : { id: itemId, kind: "reasoning", text: "" };
          turn.items.set(itemId, item);
          turn.emit({ type: "item.started", item });
        }
        turn.emit({ type: "item.delta", itemId, text: delta });
        return;
      }
      case "turn/completed": {
        const { turn: info } = (params ?? {}) as TurnCompleted;
        if (!turn) return;
        const status = info?.status;
        if (status === "interrupted" || this.interrupting) this.finish({ status: "interrupted" });
        else if (status === "failed") {
          const error = errorText(info?.error) ?? "Codex turn failed";
          turn.emit({ type: "item.completed", item: { id: newItemId("n"), kind: "notice", level: "error", text: error } });
          this.finish({ status: "failed", error });
        } else this.finish({ status: "completed" });
        return;
      }
      case "error": {
        const { error, willRetry } = (params ?? {}) as ErrorNotification;
        if (!turn || willRetry) return;
        const text = errorText(error) ?? "Codex reported an error";
        turn.emit({ type: "item.completed", item: { id: newItemId("n"), kind: "notice", level: "error", text } });
        return;
      }
      case "item/tool/requestUserInput/answered": {
        // Codex resolved the question itself: the card goes away.
        this.questions?.cancelAll();
        return;
      }
      default:
        return;
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/fileRead/requestApproval":
        // Never expected with approvalPolicy "never"; answered at once so nothing hangs.
        return { decision: this.policy.full ? "accept" : "decline" };
      case "item/tool/requestUserInput":
        return this.askUser((params ?? {}) as UserInputRequest);
      default:
        throw new RpcError({ code: -32601, message: `Unsupported request ${method}` });
    }
  }

  private async askUser(request: UserInputRequest): Promise<unknown> {
    const questions: Question[] = (request.questions ?? []).map((entry, index) => ({
      id: entry.id ?? String(index),
      header: (entry.header ?? "").slice(0, 12),
      question: entry.question ?? "",
      options: (entry.options ?? []).map((option) => ({ label: option.label ?? "", description: option.description ?? "" })),
      multiSelect: false,
      allowOther: entry.isOther !== false,
      secret: entry.isSecret === true,
    }));
    const box = this.questions;
    const empty = { answers: Object.fromEntries(questions.map((question) => [question.id, { answers: [] }])) };
    if (!box || questions.length === 0) return empty;
    const response = await box.ask(questions);
    if (response === "skip" || response === "cancel") return empty;
    return {
      answers: Object.fromEntries(questions.map((question) => [question.id, { answers: response.answers[question.id] ?? [] }])),
    };
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class CodexHarness implements Harness {
  readonly id = "codex" as const;
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
  private readonly policy: Policy = { full: true };

  constructor(version = "0.0.0") {
    this.version = version;
  }

  async probe(env: HostEnv, signal: AbortSignal): Promise<HarnessInfo> {
    const label = HARNESS_LABELS.codex;
    const binary = resolveBinary("codex", env);
    if (!binary) return { id: this.id, label, capabilities: this.capabilities, status: "not-installed", detail: "Install Codex, then reopen the picker", models: [] };

    const child = spawnAppServer(binary, process.cwd(), env.env, null);
    const peer = new JsonRpcPeer(child);
    const timer = setTimeout(() => void killTree(child), PROBE_TIMEOUT_MS);
    const onAbort = () => void killTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const { version } = await initialize(peer, this.version);
      const outdated = version && compareVersions(version, MIN_VERSION) < 0 ? `Update Codex (${version} is older than ${MIN_VERSION})` : undefined;
      const account = (await peer.request("account/read", { refreshToken: false })) as { account?: unknown; requiresOpenaiAuth?: boolean };
      if (!account.account && account.requiresOpenaiAuth) {
        return { id: this.id, label, capabilities: this.capabilities, status: "signed-out", detail: "Run `codex login` in a terminal", version, models: [] };
      }
      const list = (await peer.request("model/list", {})) as { data?: { id?: string; model?: string; displayName?: string; hidden?: boolean; isDefault?: boolean }[] };
      const models = (list.data ?? [])
        .filter((model) => !model.hidden && (model.id || model.model))
        .map((model) => ({ id: (model.id ?? model.model)!, label: model.displayName ?? (model.id ?? model.model)! }));
      const defaultModel = (list.data ?? []).find((model) => model.isDefault)?.id ?? models[0]?.id;
      return { id: this.id, label, capabilities: this.capabilities, status: "ready", detail: outdated, version, models: models.length ? models : STATIC_MODELS, defaultModel };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      if (/log ?in|not authenticated|unauthori[sz]ed/i.test(message)) {
        return { id: this.id, label, capabilities: this.capabilities, status: "signed-out", detail: "Run `codex login` in a terminal", models: [] };
      }
      return { id: this.id, label, capabilities: this.capabilities, status: "ready", detail: /exited/i.test(message) ? undefined : message, models: STATIC_MODELS, defaultModel: STATIC_MODELS[0]!.id };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void killTree(child);
    }
  }

  async open(options: OpenOptions): Promise<HarnessSession> {
    const binary = resolveBinary("codex", options.env);
    if (!binary) throw new Error("Codex is not installed");
    if (!this.policy.full) {
      options.emit({
        type: "item.completed",
        item: { id: newItemId("n"), kind: "notice", level: "info", text: "Your organization doesn't allow full access. Some actions will be blocked." },
      });
    }
    return CodexSession.start(options, this.policy, binary, this.version);
  }
}
