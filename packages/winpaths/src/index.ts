/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Windows install layout and user-PATH helpers, shared by the dapi CLI and
// the desktop app so the two never disagree about where the app lives.
//
// Squirrel installs under a versioned directory per release:
//
//   %LOCALAPPDATA%\Diffusion Studio\
//     Diffusion Studio.exe      <- stable stub, forwards to the current version
//     Update.exe
//     app-0.205.2\             <- one dir per installed version
//       Diffusion Studio.exe   <- the real, versioned binary
//       resources\cli\dapi.js  <- the staged CLI bundle
//     bin\                     <- ours: stable dapi launcher (see below)
//
// Anything addressing the app must survive updates, so nothing points into
// app-X.Y.Z directly: the GUI launches through the stable stub, and the
// `dapi` on PATH is a two-file launcher in bin\ that resolves the newest
// versioned bundle at every run.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const APP_NAME = "Diffusion Studio";
export const EXE_NAME = "Diffusion Studio.exe";
export const BUNDLE_RELATIVE = join("resources", "cli", "dapi.js");

/** The Squirrel install root, or null when %LOCALAPPDATA% is missing. */
export function squirrelRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  return join(local, APP_NAME);
}

/** The Squirrel install root derived from a packaged resources dir. */
export function rootForResources(resourcesPath: string): string {
  return join(resourcesPath, "..", "..");
}

/** The stable GUI entry point: the stub Squirrel keeps at the root. */
export function appExePath(installRoot: string): string {
  return join(installRoot, EXE_NAME);
}

/** Our stable launcher dir; never versioned, never admin-owned. */
export function stableBinDir(installRoot: string): string {
  return join(installRoot, "bin");
}

export function stableShimPath(installRoot: string): string {
  return join(stableBinDir(installRoot), "dapi.cmd");
}

export function stableBootstrapPath(installRoot: string): string {
  return join(stableBinDir(installRoot), "dapi.js");
}

/** How an MCP client spawns the stdio proxy: the Electron binary on the CLI bundle, in Node mode. */
export type WindowsStdioTarget = { command: string; args: string[]; env: Record<string, string> };

/**
 * The stdio proxy target: packaged, the stable stub on the current
 * versioned bundle; in development, the workspace Electron on the
 * workspace CLI bundle. Null when the other end is missing (an unstaged
 * dev build), so registration can say why instead of dangling.
 */
export function resolveWindowsStdio(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): WindowsStdioTarget | null {
  if (opts.isPackaged) {
    const root = rootForResources(opts.resourcesPath);
    const exe = appExePath(root);
    const bundle = currentBundlePath(root);
    if (!existsSync(exe) || !bundle) return null;
    return { command: exe, args: [bundle, "mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  const electron = join(opts.appPath, "..", "..", "node_modules", "electron", "dist", "electron.exe");
  const bundle = join(opts.appPath, "..", "cli", "dist", "index.js");
  if (!existsSync(electron) || !existsSync(bundle)) return null;
  return { command: electron, args: [bundle, "mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** Version dirs newest-first (`app-0.205.10` beats `app-0.205.2`). */
export function versionDirs(
  installRoot: string,
  readdir: (dir: string) => string[] = readdirSync,
): string[] {
  let entries: string[];
  try {
    entries = readdir(installRoot);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.toLowerCase().startsWith("app-"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * The staged CLI bundle of the newest version that actually has one, or
 * null. Skips version dirs left behind without a bundle rather than
 * pointing at a path that does not exist.
 */
export function currentBundlePath(
  installRoot: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const dir of versionDirs(installRoot)) {
    const bundle = join(installRoot, dir, BUNDLE_RELATIVE);
    if (exists(bundle)) return bundle;
  }
  return null;
}

function splitPath(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function sameDir(a: string, b: string): boolean {
  const strip = (dir: string) => dir.replace(/[\\/]+$/, "").toLowerCase();
  return strip(a) === strip(b);
}

/** Whether a PATH value already carries a directory (case-insensitive). */
export function pathHasEntry(pathValue: string | null | undefined, dir: string): boolean {
  return splitPath(pathValue).some((entry) => sameDir(entry, dir));
}

/** Adds a directory once; everything else keeps its place and spelling. */
export function addPathEntry(pathValue: string | null | undefined, dir: string): string {
  const entries = splitPath(pathValue);
  if (entries.some((entry) => sameDir(entry, dir))) return entries.join(";");
  return [...entries, dir].join(";");
}

/** Removes every spelling of a directory; everything else is untouched. */
export function removePathEntry(pathValue: string | null | undefined, dir: string): string {
  return splitPath(pathValue)
    .filter((entry) => !sameDir(entry, dir))
    .join(";");
}
