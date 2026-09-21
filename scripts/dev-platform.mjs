/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Process and executable helpers for the repo's Node launcher scripts
// (dev-desktop, stage-runtime), isolated here so they are unit-testable —
// see apps/desktop/src/dev-platform.test.mjs. Side-effect-free on import:
// every function takes an injectable runner for its subprocess calls.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const isWindows = process.platform === "win32";

/**
 * How to spawn a node_modules/.bin tool. On Windows the extensionless entry
 * is a POSIX shell script, so the .cmd shim (or .exe) next to it is what
 * runs; .cmd/.bat need the shell, which must not be used otherwise.
 */
export function resolveTool(binDir, name, { platform = process.platform } = {}) {
  if (platform !== "win32") return { file: join(binDir, name), shell: false };
  for (const ext of [".cmd", ".exe", ".bat"]) {
    const file = join(binDir, `${name}${ext}`);
    if (existsSync(file)) return { file, shell: ext !== ".exe" };
  }
  return { file: join(binDir, name), shell: true };
}

/**
 * How to run npm without a shell: the current node binary on npm's own
 * cli.js. Prefers the npm that launched this process (`npm_execpath` is set
 * by `npm run`), else the npm beside the node binary. Falls back to the
 * npm shim via the shell when neither resolves. Returns the binary plus the
 * arguments that precede npm's own.
 */
export function npmLaunch(env = process.env, execPath = process.execPath, { platform = process.platform } = {}) {
  const fromEnv = env.npm_execpath;
  if (fromEnv && existsSync(fromEnv)) return { file: execPath, prefix: [fromEnv], shell: false };
  const besideNode = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(besideNode)) return { file: execPath, prefix: [besideNode], shell: false };
  return { file: platform === "win32" ? "npm.cmd" : "npm", prefix: [], shell: platform === "win32" };
}

/**
 * Whether a command line is a Vite from this checkout (rather than some
 * other process on the dev port). Compared case-insensitively on Windows,
 * whose command lines and paths disagree about case.
 */
export function isStaleViteCommand(command, root, { platform = process.platform } = {}) {
  const win = platform === "win32";
  const hay = win ? command.toLowerCase() : command;
  const needle = (win ? root.toLowerCase() : root).replace(/[/\\]$/, "");
  return hay.includes("vite") && hay.includes(needle);
}

/**
 * One command line for cmd.exe: the file plus its arguments, each quoted
 * only when it needs it. Node refuses to escape an args array for the
 * shell (DEP0190), so the caller passes the joined line with no args —
 * ours are constants, never user input.
 */
export function shellArg(arg) {
  return /^[\w./:=@\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

export function shellCommand(file, args) {
  return [`"${file}"`, ...args.map(shellArg)].join(" ");
}

/** PIDs from `lsof -t` output; blank lines and garbage are dropped. */
export function parseLsofPids(stdout) {
  return String(stdout)
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * PID/command rows from the Windows port query below. Accepts the JSON
 * array, a single row, or nothing (an idle port serializes to no rows).
 */
export function parsePortOwners(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && Number.isInteger(row.pid) && row.pid > 0)
    .map((row) => ({ pid: row.pid, command: typeof row.command === "string" ? row.command : "" }));
}

function portScript(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);
  // One query for listeners and their command lines: Get-Process has no
  // CommandLine, so CIM provides it. @() keeps a lone row an array.
  return [
    "$ErrorActionPreference='SilentlyContinue';",
    `$conns = Get-NetTCPConnection -LocalPort ${port} -State Listen;`,
    "$rows = foreach ($c in $conns) {",
    '  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess);',
    "  [pscustomobject]@{ pid = $c.OwningProcess; command = $p.CommandLine }",
    "};",
    "ConvertTo-Json -InputObject @($rows) -Compress",
  ].join(" ");
}

/**
 * Whoever listens on a TCP port, as PID/command rows ([] when idle or
 * unknown). Windows answers in one PowerShell query; POSIX combines lsof
 * with ps per PID. `run` is injectable for tests.
 */
export function portOwners(port, { platform = process.platform, run = execFileSync } = {}) {
  try {
    if (platform === "win32") {
      const out = run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", portScript(port)],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 15000 },
      );
      return parsePortOwners(out);
    }
    const pids = parseLsofPids(run("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: ["ignore", "pipe", "ignore"] }));
    return pids.map((pid) => ({ pid, command: psCommand(pid, run) }));
  } catch {
    return [];
  }
}

function psCommand(pid, run) {
  try {
    return String(run("ps", ["-o", "command=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] })).trim();
  } catch {
    return "";
  }
}

/**
 * Ends one process. Windows goes through taskkill /T so the whole tree
 * (a .cmd shim and what it started) goes; without /F first, which asks,
 * then with it. POSIX signals directly. Throws when it fails, so the
 * caller decides what a refusal means.
 */
export function killPid(pid, force, { platform = process.platform, run = execFileSync } = {}) {
  if (platform === "win32") {
    run("taskkill", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  process.kill(pid, force ? "SIGKILL" : "SIGTERM");
}
