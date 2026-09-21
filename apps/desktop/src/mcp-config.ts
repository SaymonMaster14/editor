/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// How the app's MCP server is written into each agent's config, as pure
// text transforms: no file system, no Electron, so the merge rules are
// testable. `mcp-install.ts` decides which files and does the I/O.

/**
 * The two ways to reach the app. Agents that speak Streamable HTTP get the
 * URL, which is the same on every machine; the rest get the bundled `dapi`
 * binary in stdio proxy mode.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type McpServerSpec = { url: string; command: string; args: string[]; env?: Record<string, string> };

/**
 * The key our entry lives under in every agent's server map, and so the
 * namespace an agent shows us under: `mcp__diffusion__<tool>` and
 * `/diffusion:<prompt>`. The same word as our URL scheme, and not `dapi`,
 * which is the CLI.
 */
export const SERVER_NAME = "diffusion";

/** One agent's config entry: what its file format spells a server as. */
export type ServerEntry = Record<string, string | string[] | Record<string, string>>;

/** The stable id an agent is addressed by over IPC and in the UI. */
export type AgentId =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "codex"
  | "antigravity"
  | "gemini-cli"
  | "windsurf";

/** How a config file spells its server map: JSON under `mcpServers` (or VS Code's `servers`), or Codex's TOML tables. */
export type ConfigFormat = "mcpServers" | "servers" | "toml";

/**
 * Where an agent keeps a file: home-relative on every OS, or under the
 * per-OS app-data dir with each OS spelling its own tail. macOS tails are
 * the legacy strings, kept byte-identical; Windows tails were read off a
 * real machine, not derived by swapping a prefix.
 */
export type AgentPath = { readonly base: "home"; readonly path: string } | { readonly base: "appData"; readonly mac: string; readonly win: string };

export const home = (path: string): AgentPath => ({ base: "home", path });
export const appData = (mac: string, win: string): AgentPath => ({ base: "appData", mac, win });

/** An AgentPath as an absolute path for this (or, in tests, a given) machine. */
export function resolveAgentPath(
  p: AgentPath,
  opts: { homeDir?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string {
  const homeDir = opts.homeDir ?? homedir();
  if (p.base === "home") return join(homeDir, ...p.path.split("/"));
  const segments = (p: string): string[] => p.split("/");
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") return join(homeDir, ...DARWIN_APP_SUPPORT.split("/"), ...segments(p.mac));
  if (platform === "win32") {
    const env = opts.env ?? process.env;
    return join(env.APPDATA ?? join(homeDir, "AppData", "Roaming"), ...segments(p.win));
  }
  const env = opts.env ?? process.env;
  return join(env.XDG_CONFIG_HOME ?? join(homeDir, ".config"), ...segments(p.win));
}

export type AgentTarget = {
  id: AgentId;
  /** Human name, for the UI. */
  label: string;
  /** Location whose presence means the agent is set up on this machine. */
  marker: AgentPath;
  /** Location of the config file our entry goes into. */
  config: AgentPath;
  format: ConfigFormat;
  /** The entry for this agent: which transport it gets, under the keys its format uses. */
  entry(spec: McpServerSpec): ServerEntry;
};

const http = (key: string, extra: ServerEntry = {}) => (spec: McpServerSpec): ServerEntry => ({ ...extra, [key]: spec.url });
const stdio = (spec: McpServerSpec): ServerEntry =>
  spec.env ? { command: spec.command, args: [...spec.args], env: { ...spec.env } } : { command: spec.command, args: [...spec.args] };

/** Per-OS app-data roots live in resolveAgentPath; each entry below spells its own tail. */
export const DARWIN_APP_SUPPORT = "Library/Application Support";

// Agents whose MCP config we know how to write, in the order the UI lists
// them. Claude Code's user scope is the top-level `mcpServers` of
// ~/.claude.json, the same file `claude mcp add --scope user` edits. VS Code
// keeps its user-level servers under `servers` in the profile's mcp.json.
// Antigravity shares one config across its IDE and CLI, and only accepts
// `serverUrl`. Claude Desktop's file takes stdio commands only, so it gets
// the proxy.
export const AGENT_TARGETS: readonly AgentTarget[] = [
  { id: "claude-code", label: "Claude Code", marker: home(".claude"), config: home(".claude.json"), format: "mcpServers", entry: http("url", { type: "http" }) },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    marker: appData("Claude", "Claude"),
    config: appData("Claude/claude_desktop_config.json", "Claude/claude_desktop_config.json"),
    format: "mcpServers",
    entry: stdio,
  },
  { id: "cursor", label: "Cursor", marker: home(".cursor"), config: home(".cursor/mcp.json"), format: "mcpServers", entry: http("url") },
  {
    id: "vscode",
    label: "VS Code (Copilot)",
    marker: appData("Code", "Code"),
    config: appData("Code/User/mcp.json", "Code/User/mcp.json"),
    format: "servers",
    entry: http("url", { type: "http" }),
  },
  { id: "codex", label: "Codex", marker: home(".codex"), config: home(".codex/config.toml"), format: "toml", entry: http("url") },
  { id: "antigravity", label: "Antigravity", marker: home(".gemini/antigravity"), config: home(".gemini/config/mcp_config.json"), format: "mcpServers", entry: http("serverUrl") },
  { id: "gemini-cli", label: "Gemini CLI", marker: home(".gemini"), config: home(".gemini/settings.json"), format: "mcpServers", entry: http("httpUrl") },
  { id: "windsurf", label: "Devin (Windsurf)", marker: home(".codeium/windsurf"), config: home(".codeium/windsurf/mcp_config.json"), format: "mcpServers", entry: http("serverUrl") },
];

export function agentTarget(id: AgentId): AgentTarget {
  const target = AGENT_TARGETS.find((candidate) => candidate.id === id);
  if (!target) throw new Error(`Unknown agent: ${id}`);
  return target;
}

/** Whether the agent runs our entry over stdio, and so needs the `dapi` binary. */
export function needsBinary(target: AgentTarget): boolean {
  return "command" in target.entry({ url: "http://x", command: "x", args: [] });
}

/**
 * The config with our entry set, leaving everything else as it was. `text`
 * is the file's current content, or null when there is none yet. Throws
 * when the file cannot be parsed: a config we cannot read is not one we
 * should overwrite.
 */
export function upsertServer(text: string | null, format: ConfigFormat, entry: ServerEntry): string {
  return format === "toml" ? upsertToml(text, entry) : upsertJson(text, format, entry);
}

/**
 * The config with our entry taken out, everything else untouched; null when
 * the file has no entry of ours (or cannot be parsed), so there is nothing
 * to write back. Other servers and unrelated keys stay as they were.
 */
export function removeServer(text: string | null, format: ConfigFormat): string | null {
  if (readServer(text, format) === null) return null;
  return format === "toml" ? removeToml(text as string) : removeJson(text as string, format);
}

/** Our raw entry as the file spells it, or null when there is none (or it cannot be parsed). */
export function readEntry(text: string | null, format: ConfigFormat): Record<string, unknown> | null {
  if (text === null) return null;
  return format === "toml" ? readToml(text) : readJson(text, format);
}

/** Where our entry currently points, whatever keys the agent spells it with; null when there is none. */
export type Registered = { url?: string; command?: string };

export function readServer(text: string | null, format: ConfigFormat): Registered | null {
  if (text === null) return null;
  const entry = readEntry(text, format);
  if (!entry) return null;
  const url = entry.url ?? entry.httpUrl ?? entry.serverUrl;
  const command = entry.command;
  if (typeof url !== "string" && typeof command !== "string") return null;
  return {
    ...(typeof url === "string" ? { url } : {}),
    ...(typeof command === "string" ? { command } : {}),
  };
}

// --- JSON ------------------------------------------------------------------

type JsonFormat = Exclude<ConfigFormat, "toml">;
type JsonConfig = Record<string, unknown>;

function parseJson(text: string | null): JsonConfig {
  if (text === null || text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object at the top level");
  }
  return parsed as JsonConfig;
}

function serverMap(config: JsonConfig, root: JsonFormat): Record<string, unknown> {
  const servers = config[root];
  return typeof servers === "object" && servers !== null && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
}

function upsertJson(text: string | null, root: JsonFormat, entry: ServerEntry): string {
  const config = parseJson(text);
  config[root] = { ...serverMap(config, root), [SERVER_NAME]: entry };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function removeJson(text: string, root: JsonFormat): string {
  const config = parseJson(text);
  const { [SERVER_NAME]: _ours, ...servers } = serverMap(config, root);
  config[root] = servers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function readJson(text: string, root: JsonFormat): Record<string, unknown> | null {
  let config: JsonConfig;
  try {
    config = parseJson(text);
  } catch {
    return null;
  }
  const entry = serverMap(config, root)[SERVER_NAME];
  return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
}

// --- TOML (Codex) ----------------------------------------------------------

// Our table, from its header up to the next table header or the end. A
// header line is `[...]` at column 0; indented or commented ones are not.
const TOML_TABLE = new RegExp(String.raw`^\[mcp_servers\.${SERVER_NAME}\][^\n]*\n(?:(?!\[)[^\n]*\n?)*`, "m");

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function tomlValue(value: string | string[] | Record<string, string>): string {
  if (typeof value === "object" && !Array.isArray(value)) throw new Error("env maps are not supported in TOML configs");
  return Array.isArray(value) ? `[${value.map(tomlString).join(", ")}]` : tomlString(value);
}

function tomlTable(entry: ServerEntry): string {
  const lines = Object.entries(entry).map(([key, value]) => `${key} = ${tomlValue(value)}`);
  return [`[mcp_servers.${SERVER_NAME}]`, ...lines, ""].join("\n");
}

function upsertToml(text: string | null, entry: ServerEntry): string {
  const current = text ?? "";
  const table = tomlTable(entry);
  if (TOML_TABLE.test(current)) return current.replace(TOML_TABLE, table);
  const separator = current === "" || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${table}`;
}

// Drops our table, then the blank lines it used to sit between so the file
// does not end in (or contain) a growing gap after a connect/disconnect cycle.
function removeToml(text: string): string {
  const rest = text.replace(TOML_TABLE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  return rest === "" ? "" : `${rest}\n`;
}

function readToml(text: string): Record<string, unknown> | null {
  const table = text.match(TOML_TABLE)?.[0];
  if (!table) return null;
  const entry: Record<string, unknown> = {};
  for (const line of table.split("\n").slice(1)) {
    const scalar = line.match(/^(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/);
    if (scalar) {
      entry[scalar[1]] = untomlString(scalar[2]);
      continue;
    }
    const list = line.match(/^(\w+)\s*=\s*\[([^\]]*)\]\s*$/);
    if (list) entry[list[1]] = [...list[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => untomlString(m[1]));
  }
  return entry;
}

function untomlString(value: string): string {
  return value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}
