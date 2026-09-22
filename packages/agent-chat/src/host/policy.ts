/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent filesystem policy: one per-root read/write model mapped into
// every harness. The project root is always read/write; extra roots grant
// read (always) and optionally write; everything else is read-only unless
// the user explicitly opts into full machine access. Reads outside the
// allowed roots stay permitted — toolchains read configs, caches and
// runtimes all over the machine, and blocking that would break ordinary
// work — while every mutation path is scoped. Enforcement lives in each
// harness adapter (sandbox, approval flow, or tool hook); this module owns
// the model, the strict path math, and the tool-input analysis they share.

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import type { AccessMode, AccessState, RootGrant } from "../protocol";

const IS_WINDOWS = process.platform === "win32";

export type AccessPolicy = {
  mode: AccessMode;
  /** Canonical project root: absolute, normalized, links resolved. */
  projectRoot: string;
  /** Canonical extra roots. Empty under "project" means project-only. */
  roots: RootGrant[];
};

export type AccessCheck = { allowed: boolean; reason?: string };

export type AccessDecision = "allow" | "deny" | "ask";

export const DEFAULT_ACCESS: AccessState = { mode: "project", roots: [] };

// ---------------------------------------------------------------------------
// Canonical paths
//
// Comparison is never a raw `startsWith`: the candidate is resolved against
// the project cwd, normalized (`.`/`..` gone), stripped of `\\?\` prefixes,
// and walked through the filesystem so symlinks, junctions and 8.3 names
// resolve to what the OS would actually touch. On Windows the comparison is
// case-insensitive and drive letters are uppercased.

/** Absolute, normalized, link-resolved, separator-stable. Never ends with a separator (except a bare root). */
export function canonicalizePath(input: string, cwd?: string): string {
  const absolute = resolve(cwd ?? process.cwd(), input);
  const stripped = stripUncPrefix(absolute);
  const resolved = resolveLinks(stripped);
  return normalizeCanonical(resolved);
}

function stripUncPrefix(path: string): string {
  if (!IS_WINDOWS) return path;
  if (path.startsWith("\\\\?\\UNC\\")) return "\\\\" + path.slice("\\\\?\\UNC\\".length);
  if (path.startsWith("\\\\?\\")) return path.slice("\\\\?\\".length);
  return path;
}

function normalizeCanonical(path: string): string {
  let out = IS_WINDOWS ? path.replace(/\//g, "\\") : path;
  if (IS_WINDOWS && /^[a-z]:\\/i.test(out)) out = out[0]!.toUpperCase() + out.slice(1);
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  // A bare drive root ("C:") is not a path; restore its separator.
  if (IS_WINDOWS && /^[A-Z]:$/.test(out)) out += "\\";
  return out;
}

/**
 * Resolves the longest existing prefix through the filesystem, so a path
 * that passes through a symlink or junction compares by its target. Links
 * below the deepest existing ancestor cannot be resolved — fail closed by
 * resolving what exists and rejoining the rest lexically.
 */
function resolveLinks(absolute: string): string {
  const { root, segments } = splitRoot(absolute);
  let existing = root;
  let depth = 0;
  for (; depth < segments.length; depth++) {
    const next = existing + (existing.endsWith(sep) ? "" : sep) + segments[depth];
    if (!existsSync(next)) break;
    existing = next;
  }
  try {
    const real = stripUncPrefix(realpathSync.native(existing));
    return depth === 0 && segments.length === 0 ? real : [real, ...segments.slice(depth)].join(sep);
  } catch {
    return absolute;
  }
}

/** Splits an absolute path into its filesystem root and the segments below it. Never walks above the root. */
function splitRoot(absolute: string): { root: string; segments: string[] } {
  if (IS_WINDOWS) {
    const unc = /^\\\\[^\\]+\\[^\\]+/.exec(absolute);
    if (unc) return { root: unc[0], segments: absolute.slice(unc[0].length).split("\\").filter(Boolean) };
    const drive = /^[A-Za-z]:\\/.exec(absolute);
    if (drive) return { root: drive[0], segments: absolute.slice(drive[0].length).split("\\").filter(Boolean) };
    return { root: absolute, segments: [] };
  }
  return { root: sep, segments: absolute.split(sep).filter(Boolean) };
}

function compareKey(canonical: string): string {
  return IS_WINDOWS ? canonical.toLowerCase() : canonical;
}

/** True when `candidate` equals `root` or sits strictly beneath it. Both must be canonical. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const rootKey = compareKey(root);
  const candidateKey = compareKey(candidate);
  if (candidateKey === rootKey) return true;
  const boundary = rootKey.endsWith(sep) ? rootKey : rootKey + sep;
  return candidateKey.startsWith(boundary);
}

// ---------------------------------------------------------------------------
// Policy

export function buildPolicy(projectRoot: string, state: AccessState): AccessPolicy {
  const project = canonicalizePath(projectRoot);
  const roots = state.roots
    .map((grant) => ({ path: canonicalizePath(grant.path), write: grant.write }))
    .filter((grant) => !isWithinRoot(project, grant.path));
  return { mode: state.mode, projectRoot: project, roots };
}

/** Where a canonical path may be written: the project plus every write-granted root. */
export function writableRootsOf(policy: AccessPolicy): string[] {
  return [policy.projectRoot, ...policy.roots.filter((grant) => grant.write).map((grant) => grant.path)];
}

/** Where a canonical path may be read with the agent's working tools: project plus every approved root. */
export function readableRootsOf(policy: AccessPolicy): string[] {
  return [policy.projectRoot, ...policy.roots.map((grant) => grant.path)];
}

export function checkWrite(policy: AccessPolicy, input: string, cwd?: string): AccessCheck {
  if (policy.mode === "full") return { allowed: true };
  const candidate = canonicalizePath(input, cwd ?? policy.projectRoot);
  for (const root of writableRootsOf(policy)) {
    if (isWithinRoot(root, candidate)) return { allowed: true };
  }
  return { allowed: false, reason: `Outside the writable roots: ${input}` };
}

export function checkRead(policy: AccessPolicy, input: string, cwd?: string): AccessCheck {
  if (policy.mode === "full") return { allowed: true };
  const candidate = canonicalizePath(input, cwd ?? policy.projectRoot);
  for (const root of readableRootsOf(policy)) {
    if (isWithinRoot(root, candidate)) return { allowed: true, reason: "approved root" };
  }
  // Reads outside the approved roots stay permitted: toolchains read far
  // beyond the project, and the boundary this policy enforces is mutation.
  void candidate;
  return { allowed: true, reason: "outside roots (reads are not scoped)" };
}

/** One line per root, for instructions and the access menu. */
export function summarizePolicy(policy: AccessPolicy): string {
  if (policy.mode === "full") return "Full machine access: reads and writes anywhere.";
  const lines = [`Project (read/write): ${policy.projectRoot}`];
  for (const grant of policy.roots) lines.push(`${grant.write ? "Read/write" : "Read-only"}: ${grant.path}`);
  return lines.join("\n");
}

export function parseAccessState(value: unknown): AccessState {
  if (!value || typeof value !== "object") return { ...DEFAULT_ACCESS, roots: [] };
  const record = value as { mode?: unknown; roots?: unknown };
  const mode: AccessMode = record.mode === "full" ? "full" : "project";
  const roots: RootGrant[] = Array.isArray(record.roots)
    ? record.roots.flatMap((entry): RootGrant[] => {
        if (!entry || typeof entry !== "object") return [];
        const { path, write } = entry as { path?: unknown; write?: unknown };
        return typeof path === "string" && path.trim() ? [{ path: path.trim(), write: write === true }] : [];
      })
    : [];
  return { mode, roots };
}

// ---------------------------------------------------------------------------
// Tool analysis
//
// Harnesses that enforce at the tool layer (Claude hooks, Muse/OpenCode
// approvals) share one classifier: file tools expose their paths in known
// keys, shell commands are token-scanned for absolute paths, and anything
// unrecognized is "ask" — the harness surfaces it to the user rather than
// guessing.

/** Tools that only read. Names are Claude's; other harnesses normalize to these. */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch"]);
/** Tools that mutate the filesystem. */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "ApplyPatch"]);
/** Tools that never touch the filesystem. */
const SAFE_TOOLS = new Set(["AskUserQuestion", "TodoWrite", "EnterPlanMode", "ExitPlanMode"]);

/** Keys whose string values are filesystem paths in tool input. */
const PATH_KEYS = ["file_path", "path", "notebook_path", "directory", "folder", "dir", "filename", "root"];

function inputPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) paths.push(value);
    else if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === "string" && entry.trim()) paths.push(entry);
    }
  }
  return paths;
}

/**
 * Candidate paths inside a shell command: quoted strings, drive-letter and
 * UNC absolutes, and redirection targets. Relative tokens are resolved by
 * the caller against the session cwd, so `..` escapes out of the project
 * are caught wherever they point.
 */
export function scanShellCommand(command: string): string[] {
  const found = new Set<string>();
  const quoted = command.match(/"([^"]+)"|'([^']+)'/g) ?? [];
  for (const token of quoted) {
    const inner = token.slice(1, -1).trim();
    if (inner && !isFlag(inner) && !isUrl(inner)) found.add(inner);
  }
  const bare = command.match(/[A-Za-z]:(?!\/\/)[\\/][^\s"'|<>;&()]+|\\\\[^\s"'|<>;&()]+/g) ?? [];
  for (const token of bare) {
    if (!isUrl(token)) found.add(token);
  }
  if (!IS_WINDOWS) {
    for (const match of command.matchAll(/(?:^|[\s"'|<>;&()=])(\/[^\s"'|<>;&()]+)/g)) {
      if (match[1] && !isUrl(match[1])) found.add(match[1]);
    }
  }
  const redirects = command.match(/[12]?>+\s*("([^"]+)"|'([^']+)'|[^\s"'|<>;&()]+)/g) ?? [];
  for (const token of redirects) {
    const target = token.replace(/^[12]?>+\s*/, "").replace(/^["']|["']$/g, "").trim();
    if (target && !isFlag(target) && !isUrl(target)) found.add(target);
  }
  return [...found];
}

// Static shell scanning cannot bound every command: `cd ..\elsewhere && del *`
// carries no absolute path, and `-EncodedCommand` hides its payload entirely.
// suspiciousShell flags commands whose write target the host cannot verify, so
// harnesses can ask the user (Codex) or deny (Claude, fail-closed) instead of
// silently allowing a potential escape. Returns a human-readable reason or null.
export function suspiciousShell(command: string): string | null {
  if (/(^|[;&|]\s*|\|\|\s*|&&\s*)(cd|chdir|set-location|push-location)\b/i.test(command)) {
    return "changes directories (cd/Set-Location), so later relative paths cannot be statically bounded";
  }
  if (/(^|[\s"'\\/;&|()=])\.\.([\s"'\\/;&|()]|$)/.test(command)) {
    return "contains parent-directory traversal (..)";
  }
  if (/-encodedcommand\b/i.test(command) || /frombase64string/i.test(command)) {
    return "hides its payload in an encoded command";
  }
  if (/\biex\b/i.test(command) || /\binvoke-expression\b/i.test(command)) {
    return "evaluates a dynamic expression (Invoke-Expression)";
  }
  return null;
}

/** Verbs that never mutate the filesystem on their own (no redirect). */
const SHELL_READ_VERBS = new Set([
  "type", "cat", "dir", "ls", "get-content", "gc", "get-childitem", "gci", "findstr", "grep",
  "select-string", "sls", "sort", "measure-object", "head", "tail", "more", "less",
  "echo", "print", "write-output", "write-host", "where", "which", "get-command",
]);

/** Verbs that mutate the filesystem (or obviously wrap mutation). */
const SHELL_MUTATE_VERBS = new Set([
  "del", "erase", "rm", "remove-item", "ri", "copy", "cp", "copy-item", "cpi", "xcopy", "robocopy",
  "move", "mv", "move-item", "mi", "ren", "rename", "rename-item", "mkdir", "md", "new-item",
  "rmdir", "rd", "out-file", "tee", "tee-object", "set-content", "sc", "add-content", "ac",
  "clear-content", "clc", "new-itemproperty", "set-itemproperty", "remove-itemproperty",
  "takeown", "icacls", "attrib",
]);

/**
 * Strips one layer of `powershell -Command "..."` / `cmd /c "..."` wrapping
 * so the inner command — the part that actually touches the filesystem — is
 * what gets classified and scanned. Without this, `powershell -Command
 * "del ..\\..\\x"` hides a relative traversal inside a quoted blob that the
 * path scanner treats as one harmless in-project candidate. `-File` and
 * `-EncodedCommand` are NOT unwrapped: they run opaque payloads.
 */
export function unwrapShellCommand(command: string, depth = 0): string {
  if (depth > 2) return command;
  const match = command.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*(.*)$/s);
  if (!match) return command;
  const verb = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1|com)$/i, "").toLowerCase();
  if (verb !== "powershell" && verb !== "pwsh" && verb !== "cmd") return command;
  const rest = match[4] ?? "";
  if (/^\s*-(file|encodedcommand|ec)\b/i.test(rest)) return command;
  const inner = rest.replace(/^\s*(?:-(?:command|c)|\/c)\b\s*/i, "").trim().replace(/^(["'])(.*)\1$/s, "$2");
  if (!inner) return command;
  return unwrapShellCommand(inner, depth + 1);
}

/**
 * Classifies a shell command by filesystem effect: "read" when every segment
 * is a known read-only verb with no file redirect, "mutate" when a redirect
 * or mutating verb is present, "unknown" otherwise (interpreters, pipes to
 * unknown commands, `-File` payloads). Unknown fails closed into the write
 * check: running a program can do anything, so its referenced paths must be
 * writable. Never returns "read" for an empty/unparseable command.
 */
export function classifyShellCommand(command: string): "read" | "mutate" | "unknown" {
  const bare = unwrapShellCommand(command).replace(/"[^"]*"|'[^']*'/g, " ");
  if (/\d?>>?\s*[^&\s]/.test(bare)) return "mutate";
  const segments = bare.split(/;|\|\||&&|\|(?!\|)|\s&\s|&\s|\s&/);
  let sawVerb = false;
  for (const segment of segments) {
    const token = segment.trim().split(/\s+/, 1)[0] ?? "";
    const verb = token.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1|com)$/i, "").toLowerCase();
    if (!verb || /^[^\w]+$/.test(verb)) continue;
    sawVerb = true;
    if (SHELL_MUTATE_VERBS.has(verb)) return "mutate";
    if (!SHELL_READ_VERBS.has(verb)) return "unknown";
  }
  return sawVerb ? "read" : "unknown";
}

function isFlag(token: string): boolean {
  if (token.startsWith("-")) return true;
  // On Windows `/Q`-style flags exist; anything longer with a separator is a path.
  return IS_WINDOWS && /^\/[a-z?]/i.test(token) && !token.includes("/", 1) && !token.includes("\\");
}

function isUrl(token: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(token);
}

export type ToolVerdict = { decision: AccessDecision; paths: string[]; reason?: string };

/**
 * Classifies one tool call. Reads are allowed; writes inside the writable
 * roots are allowed; writes outside are denied with a reason the agent can
 * act on (ask the user to approve the folder or switch access mode).
 * Unknown tools — including future ones — are "ask", never silent allow.
 */
export function decideToolAction(policy: AccessPolicy, cwd: string, toolName: string, input: Record<string, unknown>): ToolVerdict {
  if (policy.mode === "full") return { decision: "allow", paths: [] };
  // Diffusion's own MCP tools act on the open project through the editor,
  // which is project-scoped by construction — not a filesystem escape.
  if (toolName.startsWith("mcp__")) return { decision: "allow", paths: [] };
  if (SAFE_TOOLS.has(toolName)) return { decision: "allow", paths: [] };
  if (toolName === "Bash" || toolName === "Shell" || toolName === "shell" || toolName === "bash") {
    const command = unwrapShellCommand(typeof input.command === "string" ? input.command : "");
    const suspicious = suspiciousShell(command);
    if (suspicious) {
      return {
        decision: "ask",
        paths: [],
        reason: `Shell command ${suspicious}. The host cannot verify where it writes: approve the exact command or rewrite it with explicit in-project paths.`,
      };
    }
    // Read-only shell commands (type/cat/dir, no redirect) behave like the
    // Read tool: reads are allowed everywhere, including read-only roots.
    // Anything else — mutating or unclassifiable — must reference only
    // writable paths, because running a program can do anything.
    if (classifyShellCommand(command) === "read") return { decision: "allow", paths: scanShellCommand(command) };
    const paths = scanShellCommand(command);
    for (const candidate of paths) {
      const check = checkWrite(policy, candidate, cwd);
      if (!check.allowed) {
        return {
          decision: "deny",
          paths,
          reason: `Shell command touches ${candidate}, outside the writable roots. Ask the user to approve the folder or switch Agent Access to full machine access.`,
        };
      }
    }
    return { decision: "allow", paths };
  }
  if (READ_TOOLS.has(toolName)) return { decision: "allow", paths: inputPaths(input) };
  if (WRITE_TOOLS.has(toolName)) {
    const paths = inputPaths(input);
    for (const candidate of paths) {
      const check = checkWrite(policy, candidate, cwd);
      if (!check.allowed) {
        return {
          decision: "deny",
          paths,
          reason: `Write to ${candidate} is outside the writable roots. Ask the user to approve the folder or switch Agent Access to full machine access.`,
        };
      }
    }
    return { decision: "allow", paths };
  }
  return { decision: "ask", paths: inputPaths(input), reason: `Unknown tool ${toolName}: needs the user.` };
}

export function isAbsolutePathLike(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
