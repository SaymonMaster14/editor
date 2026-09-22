/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Claude Code through the Agent SDK, pointed at the user's own `claude`.
// One long-lived `query()` per live session: its prompt is a queue that
// `send` pushes to, and a single pump reads every message the CLI emits
// and folds it into the running turn. Interrupt closes the query — the
// next send re-opens it from the session id we chose up front.

import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { HARNESS_LABELS } from "../protocol";
import { compareVersions, parseVersion, resolveBinary, resolveClaudeExecutable, runOnce } from "./env";
import { QuestionBox, collectResult, newItemId, summarizeInput, toolTitle, truncateDetail } from "./harness";
import { buildPolicy, decideToolAction } from "./policy";

import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { HarnessCapabilities, HarnessInfo, Item, Question, RequestResponse } from "../protocol";
import type { HostEnv } from "./env";
import type { Emit, Harness, HarnessSession, OpenOptions, ResumeCursor, TurnOutcome } from "./harness";
import type { AccessPolicy } from "./policy";

const MIN_VERSION = "2.0.0";
const PROBE_TIMEOUT_MS = 25_000;

/** What the picker shows when the CLI is there but the probe could not ask it. */
const STATIC_MODELS = [
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "opus", label: "Opus 5" },
  { id: "sonnet", label: "Sonnet 5" },
];

/** The rows the CLI reports, as far as the picker reads them. */
export type ClaudeModelRow = { value: string; displayName: string; resolvedModel?: string };

/**
 * "Fable 5.1", "Opus 5", "Haiku 4.5": family and version from the wire id
 * (`claude-fable-5-1`, `claude-haiku-4-5-20251001`), which is what a video
 * editor recognises. The CLI's own labels ("Default (recommended)", "Opus
 * (1M context)") are kept only where the id has no version to read.
 */
export function claudeModelLabel(row: ClaudeModelRow): string {
  const wire = (row.resolvedModel ?? row.value).replace(/\[[^\]]*\]$/, "");
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i.exec(wire);
  if (!match) return row.displayName;
  const family = match[1]![0]!.toUpperCase() + match[1]!.slice(1).toLowerCase();
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

/**
 * The picker's list: one row per model, in the CLI's order. Aliases that
 * resolve to the same model (`default` and `opus[1m]`) collapse into the
 * first named one, and the default is whichever row `default` resolves to.
 */
export function claudeModels(rows: ClaudeModelRow[]): { models: { id: string; label: string }[]; defaultModel?: string } {
  const byResolved = new Map<string, { id: string; label: string }>();
  let defaultResolved: string | undefined;
  for (const row of rows) {
    const resolved = row.resolvedModel ?? row.value;
    if (row.value === "default") {
      defaultResolved = resolved;
      if (byResolved.has(resolved) || rows.some((other) => other !== row && (other.resolvedModel ?? other.value) === resolved)) continue;
    }
    if (!byResolved.has(resolved)) byResolved.set(resolved, { id: row.value, label: claudeModelLabel(row) });
  }
  const models = [...byResolved.values()];
  const defaultModel = (defaultResolved && byResolved.get(defaultResolved)?.id) ?? models[0]?.id;
  return { models, defaultModel };
}

/** Which permission mode a chat uses: bypass only by explicit opt-in, else default with host-side tool decisions. */
export type ClaudePolicy = { mode: PermissionMode; access: AccessPolicy };

/** Maps Diffusion access onto Claude: bypass only by explicit opt-in, else default mode with host-side tool decisions. */
export function claudePolicyFor(access: AccessPolicy | undefined, cwd: string, fullRefused: boolean): ClaudePolicy {
  const policy = access ?? buildPolicy(cwd, { mode: "project", roots: [] });
  const full = policy.mode === "full" && !fullRefused;
  return { mode: full ? "bypassPermissions" : "default", access: policy };
}

/** An async iterable that `send` feeds and the SDK drains. */
class Queue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

const NEVER: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
};

function childEnv(host: HostEnv, version: string): Record<string, string> {
  return {
    ...host.env,
    CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
    CLAUDE_AGENT_SDK_CLIENT_APP: `diffusion-studio/${version}`,
  };
}

/** A day, in the seconds the SDK counts hook timeouts in: a question waits as long as the user does. */
const QUESTION_TIMEOUT_S = 24 * 60 * 60;

/** The tool whose call is the one thing an agent may wait on. */
const ASK_USER_QUESTION = "AskUserQuestion";

const SIGN_IN_HINT = "Run `claude auth login` in a terminal";

/** What the CLI says when it has no usable login: the expired-OAuth message among them. */
export function isAuthFailure(text: string): boolean {
  return /failed to authenticate|oauth|not (?:logged|signed) in|log ?in|unauthori[sz]ed|authentication/i.test(text);
}

/**
 * `claude auth status` prints `{ "loggedIn": false, "authMethod": "none", … }`.
 * Null when the command is missing (an older CLI) or says nothing useful,
 * in which case the session decides on its first request.
 */
async function loggedIn(binary: string, env: HostEnv): Promise<boolean | null> {
  const output = await runOnce(binary, ["auth", "status"], env, 8000);
  if (!output) return null;
  try {
    const parsed = JSON.parse(output.slice(output.indexOf("{"))) as { loggedIn?: unknown };
    return typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null;
  } catch {
    const match = /"loggedIn"\s*:\s*(true|false)/.exec(output);
    return match ? match[1] === "true" : null;
  }
}

/** The errors that mean "bypass is not allowed here", and nothing else. */
export function isBypassRefused(text: string): boolean {
  return /(bypass|dangerously-skip-permissions|skip.?permissions)/i.test(text) && /(disabled|not allowed|cannot|forbidden|policy|root|sudo|managed)/i.test(text);
}

type Turn = {
  emit: Emit;
  resolve(outcome: TurnOutcome): void;
  text: string;
  /** Open text / thinking items, oldest first, waiting for their final block. */
  openText: string[];
  openThinking: string[];
  /** Stream index → item id for the message being streamed. */
  blocks: Map<number, string>;
  /** What has streamed into each open text / thinking item, by id. */
  streamed: Map<string, string>;
  tools: Map<string, Extract<Item, { kind: "tool" }>>;
};

class ClaudeSession implements HarnessSession {
  readonly resume: ResumeCursor;
  private readonly options: OpenOptions;
  private readonly claudePath: string;
  private policy: ClaudePolicy;
  private readonly onFullRefused?: () => void;
  private readonly version: string;
  private readonly sessionId: string;
  private q: Query | null = null;
  private queue: Queue<SDKUserMessage> | null = null;
  private pump: Promise<void> | null = null;
  private model: string;
  private turn: Turn | null = null;
  private questions: QuestionBox | null = null;
  private interrupting = false;
  private initialized = false;
  private stderr = "";
  /** Set once the resume cursor points at a session the CLI has written. */
  private started: boolean;

  constructor(options: OpenOptions, claudePath: string, policy: ClaudePolicy, version: string, onFullRefused?: () => void) {
    this.onFullRefused = onFullRefused;
    this.options = options;
    this.claudePath = claudePath;
    this.policy = policy;
    this.version = version;
    this.model = options.model;
    const resumed = options.resume && "claude" in options.resume ? options.resume.claude.sessionId : null;
    this.sessionId = resumed ?? randomUUID();
    this.started = resumed !== null;
    this.resume = { claude: { sessionId: this.sessionId } };
  }

  private open(model: string): void {
    const queue = new Queue<SDKUserMessage>();
    this.queue = queue;
    this.model = model;
    this.initialized = false;
    this.stderr = "";
    const mcp = this.options.mcp;
    const bypass = this.policy.mode === "bypassPermissions";
    const extraDirs = this.policy.access.roots.map((grant) => grant.path);
    const options: Options = {
      cwd: this.options.cwd,
      ...(extraDirs.length ? { additionalDirectories: extraDirs } : {}),
      model,
      pathToClaudeCodeExecutable: this.claudePath,
      permissionMode: this.policy.mode,
      disallowedTools: ["Agent", "Task"],
      ...(bypass ? { allowDangerouslySkipPermissions: true } : {}),
      ...(this.started ? { resume: this.sessionId } : { sessionId: this.sessionId }),
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code", append: this.options.instructions },
      mcpServers: mcp ? { [mcp.name]: { type: "http", url: mcp.url } } : {},
      // Under bypassPermissions the CLI approves every call before
      // `canUseTool` is consulted, so a question would run with no answers
      // and return nothing. A PreToolUse hook runs first in every mode: it
      // shows the card and hands the answers back as the tool's input.
      hooks: { PreToolUse: [{ matcher: ASK_USER_QUESTION, hooks: [this.preToolUse], timeout: QUESTION_TIMEOUT_S }] },
      canUseTool: this.canUseTool,
      env: { ...childEnv(this.options.env, this.version), CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: "1" },
      stderr: (data) => {
        this.stderr = (this.stderr + data).slice(-8192);
      },
    };
    const q = query({ prompt: queue, options });
    this.q = q;
    this.started = true;
    this.pump = this.run(q);
  }

  private async run(q: Query): Promise<void> {
    let failure: Error | null = null;
    try {
      for await (const message of q) {
        if (this.q !== q) break;
        this.dispatch(message);
      }
    } catch (error) {
      failure = error as Error;
    }
    if (this.q === q) {
      this.q = null;
      this.queue = null;
    }
    const turn = this.turn;
    if (!turn) return;
    // A refused bypass shows up as a dead process before init: retry the
    // same turn once with the next mode down, and say so in the chat.
    if (failure && !this.initialized && !this.interrupting && this.tightenPolicy()) {
      turn.emit({
        type: "item.completed",
        item: { id: newItemId("n"), kind: "notice", level: "info", text: "Your organization doesn't allow full access. Some actions will be blocked." },
      });
      this.open(this.model);
      this.queue!.push(this.userMessage(turn.text));
      return;
    }
    this.finish(this.interrupting ? { status: "interrupted" } : { status: "failed", error: failure?.message ?? "Claude Code exited" });
  }

  /** Steps the policy down when the CLI refused bypass; false when there is nothing left to try. */
  private tightenPolicy(): boolean {
    if (!isBypassRefused(this.stderr)) return false;
    if (this.policy.mode === "bypassPermissions") {
      // An org that refuses bypass gets project-scoped enforcement, not silent allow-all.
      this.policy.mode = "auto";
      this.policy.access = { ...this.policy.access, mode: "project" };
      this.onFullRefused?.();
    }
    else if (this.policy.mode === "auto") this.policy.mode = "default";
    else return false;
    return true;
  }

  private userMessage(text: string): SDKUserMessage {
    return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: this.sessionId };
  }

  async send(text: string, model: string, emit: Emit): Promise<TurnOutcome> {
    if (this.turn) throw new Error("A turn is already running");
    this.interrupting = false;
    if (!this.q) this.open(model);
    else if (model !== this.model) {
      await this.q.setModel(model);
      this.model = model;
    }
    this.questions = new QuestionBox(emit);
    return new Promise<TurnOutcome>((resolve) => {
      this.turn = { emit, resolve, text, openText: [], openThinking: [], blocks: new Map(), streamed: new Map(), tools: new Map() };
      this.queue!.push(this.userMessage(text));
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
    this.interrupting = true;
    this.questions?.cancelAll();
    const q = this.q;
    this.q = null;
    this.queue = null;
    q?.close();
    await this.pump?.catch(() => {});
    this.finish({ status: "interrupted" });
  }

  async close(): Promise<void> {
    await this.interrupt();
  }

  // -------------------------------------------------------------------
  // Permissions and questions

  /** The question, asked before the tool runs (see `open`); every other tool passes through. */
  private readonly preToolUse: HookCallback = async (input, _toolUseId, { signal }): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== ASK_USER_QUESTION) return {};
    const result = await this.askUser((input.tool_input ?? {}) as Record<string, unknown>, signal);
    if (result.behavior === "allow") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: result.updatedInput } };
    }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: result.message } };
  };

  /** Every tool call lands here (bypass is gone except under full access): the access policy decides. */
  private readonly canUseTool: CanUseTool = async (toolName, input, { signal }) => {
    if (toolName === ASK_USER_QUESTION) return this.askUser(input, signal);
    const verdict = decideToolAction(this.policy.access, this.options.cwd, toolName, input);
    if (verdict.decision !== "allow") {
      // "ask" fails closed too: headless, there is no CLI prompt to defer to, so the agent asks the user with a question.
      return { behavior: "deny", message: verdict.reason ?? `The access policy blocked ${toolName}.` };
    }
    return { behavior: "allow", updatedInput: input };
  };

  private async askUser(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const raw = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
    const questions: Question[] = raw.map((entry) => ({
      id: String(entry.question ?? ""),
      header: String(entry.header ?? "").slice(0, 12),
      question: String(entry.question ?? ""),
      options: Array.isArray(entry.options)
        ? (entry.options as Record<string, unknown>[]).map((option) => ({
            label: String(option.label ?? ""),
            description: String(option.description ?? ""),
          }))
        : [],
      multiSelect: entry.multiSelect === true,
      allowOther: true,
      secret: false,
    }));
    const box = this.questions;
    if (!box || questions.length === 0) {
      return { behavior: "deny", message: "The question could not be shown. Proceed with your best judgement." };
    }
    const response = await box.ask(questions, signal);
    if (response === "skip") return { behavior: "deny", message: "The user skipped the question. Proceed with your best judgement." };
    if (response === "cancel") return { behavior: "deny", message: "The user stopped the turn." };
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const chosen = response.answers[question.id];
      if (chosen && chosen.length) answers[question.id] = chosen.join(", ");
    }
    return { behavior: "allow", updatedInput: { questions: input.questions, answers } };
  }

  // -------------------------------------------------------------------
  // SDK messages → events

  private dispatch(message: SDKMessage): void {
    const turn = this.turn;
    if (message.type === "system" && message.subtype === "init") {
      this.initialized = true;
      return;
    }
    if (!turn) return;
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return;

    switch (message.type) {
      case "stream_event": {
        const event = message.event;
        if (event.type === "message_start") {
          turn.blocks.clear();
        } else if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "text") {
            const id = newItemId("a");
            turn.blocks.set(event.index, id);
            turn.openText.push(id);
            turn.emit({ type: "item.started", item: { id, kind: "assistant", text: "" } });
          } else if (block.type === "thinking") {
            const id = newItemId("r");
            turn.blocks.set(event.index, id);
            turn.openThinking.push(id);
            turn.emit({ type: "item.started", item: { id, kind: "reasoning", text: "" } });
          } else if (block.type === "tool_use") {
            const item: Extract<Item, { kind: "tool" }> = { id: block.id, kind: "tool", name: block.name, title: toolTitle(block.name), status: "running" };
            turn.tools.set(block.id, item);
            turn.emit({ type: "item.started", item });
          }
        } else if (event.type === "content_block_delta") {
          const id = turn.blocks.get(event.index);
          if (!id) return;
          const delta = event.delta.type === "text_delta" ? event.delta.text : event.delta.type === "thinking_delta" ? event.delta.thinking : null;
          if (delta === null || delta === "") return;
          turn.streamed.set(id, (turn.streamed.get(id) ?? "") + delta);
          turn.emit({ type: "item.delta", itemId: id, text: delta });
        }
        return;
      }

      case "assistant": {
        // An API failure arrives as an assistant message carrying the error
        // text; the `result` that follows reports it once, as a notice.
        if (message.error) return;
        for (const block of message.message.content) {
          // The final block is the record; what streamed stands in when the
          // final block comes back empty (thinking the model keeps to itself
          // arrives as a signed block with no text).
          if (block.type === "text") {
            const id = turn.openText.shift() ?? newItemId("a");
            turn.emit({ type: "item.completed", item: { id, kind: "assistant", text: block.text || turn.streamed.get(id) || "" } });
            turn.streamed.delete(id);
          } else if (block.type === "thinking") {
            const id = turn.openThinking.shift() ?? newItemId("r");
            turn.emit({ type: "item.completed", item: { id, kind: "reasoning", text: block.thinking || turn.streamed.get(id) || "" } });
            turn.streamed.delete(id);
          } else if (block.type === "tool_use") {
            const item: Extract<Item, { kind: "tool" }> = {
              ...(turn.tools.get(block.id) ?? { id: block.id, kind: "tool", name: block.name, title: toolTitle(block.name), status: "running" }),
              detail: summarizeInput(block.input),
            };
            turn.tools.set(block.id, item);
            turn.emit({ type: "item.started", item });
          }
        }
        return;
      }

      case "user": {
        const content = message.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const started = turn.tools.get(block.tool_use_id);
          if (!started) continue;
          const result = typeof block.content === "string"
            ? { ...(block.content ? { output: truncateDetail(block.content) } : {}) }
            : collectResult(block.content ?? []);
          const item: Extract<Item, { kind: "tool" }> = {
            ...started,
            status: block.is_error ? "failed" : "done",
            ...result,
          };
          turn.tools.delete(block.tool_use_id);
          turn.emit({ type: "item.completed", item });
        }
        return;
      }

      case "result": {
        for (const denial of message.permission_denials ?? []) {
          turn.emit({
            type: "item.completed",
            item: { id: newItemId("n"), kind: "notice", level: "info", text: `Blocked: ${toolTitle(denial.tool_name)}${summarizeInput(denial.tool_input) ? ` · ${summarizeInput(denial.tool_input)}` : ""}` },
          });
        }
        if (message.subtype === "success" && !message.is_error) {
          this.finish({ status: "completed" });
        } else {
          const errors = (message as { errors?: string[] }).errors;
          const raw = message.subtype === "success" ? message.result : errors?.join("\n") || message.subtype.replace(/_/g, " ");
          // An expired login reads as a plain API error; say what to do about it.
          const text = isAuthFailure(raw) ? `Claude Code is signed out. ${SIGN_IN_HINT}, then send again.` : raw;
          turn.emit({ type: "item.completed", item: { id: newItemId("n"), kind: "notice", level: "error", text } });
          this.finish({ status: "failed", error: text });
        }
        return;
      }

      default:
        return;
    }
  }
}

export class ClaudeHarness implements Harness {
  readonly id = "claude" as const;
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    images: true,
    attachments: true,
    mcp: true,
    approvals: false,
    questions: true,
    interrupt: true,
    resume: true,
    models: true,
    sessions: true,
    sandbox: false,
    readRoots: true,
    writeRoots: true,
  };
  private readonly version: string;
  /** Remembered while the host runs: once an org refused bypass, every chat starts project-scoped. */
  private fullRefused = false;

  constructor(version = "0.0.0") {
    this.version = version;
  }

  async probe(env: HostEnv, signal: AbortSignal): Promise<HarnessInfo> {
    const label = HARNESS_LABELS.claude;
    const binary = resolveBinary("claude", env);
    if (!binary) {
      return { id: this.id, label, capabilities: this.capabilities, status: "not-installed", detail: "Install Claude Code, then reopen the picker", models: [] };
    }
    const version = parseVersion(await runOnce(binary, ["--version"], env));
    const outdated = version && compareVersions(version, MIN_VERSION) < 0 ? `Update Claude Code (${version} is older than ${MIN_VERSION})` : undefined;
    if ((await loggedIn(binary, env)) === false) {
      return { id: this.id, label, capabilities: this.capabilities, status: "signed-out", detail: SIGN_IN_HINT, version, models: [] };
    }
    const path = resolveClaudeExecutable(binary);

    let models = STATIC_MODELS;
    let defaultModel: string | undefined = STATIC_MODELS[0]!.id;
    let detail = outdated;
    const q = query({
      prompt: NEVER,
      options: {
        pathToClaudeCodeExecutable: path,
        persistSession: false,
        strictMcpConfig: true,
        mcpServers: {},
        settingSources: ["user"],
        settings: JSON.stringify({ disableAllHooks: true }),
        env: childEnv(env, this.version),
      },
    });
    try {
      const init = await withTimeout(q.initializationResult(), PROBE_TIMEOUT_MS, signal);
      const listed = claudeModels(init.models);
      if (listed.models.length) {
        models = listed.models;
        defaultModel = listed.defaultModel;
      }
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      if (isAuthFailure(message)) {
        return { id: this.id, label, capabilities: this.capabilities, status: "signed-out", detail: SIGN_IN_HINT, version, models: [] };
      }
      // The binary is there; whatever went wrong will show on the first send.
      detail ??= /timed out/i.test(message) ? undefined : message;
    } finally {
      q.close();
    }
    return { id: this.id, label, capabilities: this.capabilities, status: "ready", detail, version, models, defaultModel };
  }

  async open(options: OpenOptions): Promise<HarnessSession> {
    const binary = resolveBinary("claude", options.env);
    if (!binary) throw new Error("Claude Code is not installed");
    const policy = claudePolicyFor(options.access, options.cwd, this.fullRefused);
    if (options.access?.mode === "full" && policy.mode !== "bypassPermissions") {
      options.emit({
        type: "item.completed",
        item: { id: newItemId("n"), kind: "notice", level: "info", text: "Your organization doesn't allow full access. Some actions will be blocked." },
      });
    }
    return new ClaudeSession(options, resolveClaudeExecutable(binary), policy, this.version, () => {
      this.fullRefused = true;
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
