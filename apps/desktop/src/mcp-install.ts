/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Registers the app's MCP server with the agents on this machine, one agent
// at a time as the settings page asks: the fixed loopback URL for agents
// that speak HTTP, the bundled `dapi mcp` proxy for the rest. No PATH
// symlink and no admin prompt — that is `cli-install.ts`, for people who
// type `dapi`.

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MCP_URL } from "@diffusionstudio/dapi";
import { resolveWindowsStdio } from "@diffusionstudio/winpaths";
import { AGENT_TARGETS, agentTarget, needsBinary, readEntry, readServer, removeServer, resolveAgentPath, upsertServer } from "./mcp-config";

import type { AgentTarget, McpServerSpec } from "./mcp-config";
import type { McpAgentStatus, McpApplyRequest, McpApplyResult, McpStatus } from "./main-channels";

// On macOS the dev workflow links the workspace build into Homebrew's bin
// (`symlink:create` in apps/cli); that is the binary a macOS dev build registers.
const DEV_BINARY = "/opt/homebrew/bin/dapi";

/**
 * Everything about this machine the registration reads: home, platform and
 * env for the agent config paths, packaging state and install layout for
 * the stdio proxy target. Live callers omit it; tests point it at a
 * fixture home so no real user config is ever touched.
 */
export type McpInstallEnv = {
  homeDir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
};

function liveEnv(): McpInstallEnv {
  return {
    homeDir: homedir(),
    platform: process.platform,
    env: process.env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  };
}

/** The bundled `dapi` binary, or null when none is available (an unstaged dev build). */
export function dapiBinary(e: McpInstallEnv = liveEnv()): string | null {
  const command = e.isPackaged ? join(e.resourcesPath, "cli", "bin", "dapi") : DEV_BINARY;
  return existsSync(command) ? command : null;
}

function spec(e: McpInstallEnv): McpServerSpec {
  if (e.platform === "win32") {
    const stdio = resolveWindowsStdio(e);
    if (stdio) return { url: MCP_URL, command: stdio.command, args: stdio.args, env: stdio.env };
    return { url: MCP_URL, command: "", args: ["mcp"] };
  }
  return { url: MCP_URL, command: dapiBinary(e) ?? "", args: ["mcp"] };
}

function configPath(target: AgentTarget, e: McpInstallEnv): string {
  return resolveAgentPath(target.config, e);
}

function readConfig(target: AgentTarget, e: McpInstallEnv): string | null {
  const path = configPath(target, e);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function writeConfig(target: AgentTarget, e: McpInstallEnv, text: string): void {
  const path = configPath(target, e);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * Why this agent cannot be connected from this build, or null when it can.
 * Only the stdio agents have reasons: a build without the `dapi` binary has
 * nothing for them to run, and a quarantined first launch runs from a
 * translocated read-only mount whose path won't survive the next launch —
 * registering it would dangle.
 */
function unavailableReason(target: AgentTarget, current: McpServerSpec, e: McpInstallEnv): string | null {
  if (!needsBinary(target)) return null;
  if (current.command === "") return "Needs the dapi command line tool, which this build does not include.";
  if (e.isPackaged && current.command.includes("/AppTranslocation/")) {
    return "Move Diffusion Studio to the Applications folder and relaunch it first.";
  }
  return null;
}

function agentStatus(target: AgentTarget, current: McpServerSpec, e: McpInstallEnv): McpAgentStatus {
  const registered = readServer(readConfig(target, e), target.format);
  return {
    id: target.id,
    label: target.label,
    detected: existsSync(resolveAgentPath(target.marker, e)),
    connected: registered !== null,
    config: configPath(target, e),
    unavailable: unavailableReason(target, current, e),
  };
}

/** Every agent we know, with whether it is on this machine and whether its config carries our entry. */
export function mcpStatus(e: McpInstallEnv = liveEnv()): McpStatus {
  const current = spec(e);
  return { url: current.url, agents: AGENT_TARGETS.map((target) => agentStatus(target, current, e)) };
}

/**
 * Writes our entry into the configs of `add` and takes it out of the configs
 * of `remove`, one file at a time, so one unreadable config does not stop
 * the rest. Other servers in the same file are left alone either way.
 */
export function applyMcp(request: McpApplyRequest, e: McpInstallEnv = liveEnv()): McpApplyResult {
  const current = spec(e);
  const result: McpApplyResult = { added: [], removed: [], failures: [] };

  for (const id of request.add) {
    const target = agentTarget(id);
    const reason = unavailableReason(target, current, e);
    if (reason) {
      result.failures.push({ id, error: reason });
      continue;
    }
    try {
      writeConfig(target, e, upsertServer(readConfig(target, e), target.format, target.entry(current)));
      result.added.push(id);
    } catch (err) {
      result.failures.push({ id, error: `${configPath(target, e)}: ${(err as Error).message}` });
    }
  }

  for (const id of request.remove) {
    const target = agentTarget(id);
    try {
      const next = removeServer(readConfig(target, e), target.format);
      if (next !== null) writeConfig(target, e, next);
      result.removed.push(id);
    } catch (err) {
      result.failures.push({ id, error: `${configPath(target, e)}: ${(err as Error).message}` });
    }
  }

  return result;
}

/**
 * Launch-time self-heal for the stdio agents: an entry that still runs the
 * proxy from a bundle that moved (or was translocated when it was written)
 * is rewritten to the binary this build has. Entries the user wrote by hand
 * for something else are left alone.
 */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Whether two arg vectors spell the same invocation, order included. */
function argsEqual(a: unknown, b: unknown): boolean {
  const left = stringList(a);
  const right = stringList(b);
  return left.length === right.length && left.every((item, i) => item === right[i]);
}

export function healMcpRegistrations(e: McpInstallEnv = liveEnv()): void {
  if (!e.isPackaged) return;
  const current = spec(e);
  if (current.command === "" || current.command.includes("/AppTranslocation/")) return;

  for (const target of AGENT_TARGETS) {
    const text = readConfig(target, e);
    const registered = readServer(text, target.format);
    if (!registered?.command) continue;
    const ours = registered.command.includes("Diffusion Studio") || registered.command.includes("/AppTranslocation/");
    if (!ours) continue;
    const entry = target.entry(current);
    if (registered.command === entry.command && argsEqual(readEntry(text, target.format)?.args, entry.args)) continue;
    try {
      writeConfig(target, e, upsertServer(text, target.format, entry));
    } catch {
      // best effort — the settings page remains as a manual fix
    }
  }
}
