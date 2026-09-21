/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Windows `dapi` on PATH: a two-file launcher in the stable
// <install root>\bin (see staged-cli/ and @diffusionstudio/winpaths),
// plus that directory on the user's PATH. No admin anywhere: the bin
// lives in the user's own install root and PATH is the per-user one.
//
// Everything touching the real machine arrives through WinCliEnv, so the
// rules — idempotent install, never touch an unrelated `dapi`, only
// remove what Diffusion Studio owns — are tested against fixtures (see
// cli-install-win.test.ts) instead of the developer's PATH.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { addPathEntry, pathHasEntry, removePathEntry, rootForResources, stableBinDir } from "@diffusionstudio/winpaths";

import type { CliInstallResult, CliStatus, CliUninstallResult } from "./main-channels";

export const SHIM_NAME = "dapi.cmd";
export const BOOTSTRAP_NAME = "dapi.js";
export const SHIM_SIGNATURE = "diffusion-studio-dapi-shim";

export type WinCliEnv = {
  isPackaged: boolean;
  resourcesPath: string;
  /** The user's PATH, "" when empty, null when it cannot be read. */
  readUserPath: () => string | null;
  writeUserPath: (value: string) => void;
  /** Every `dapi` the shell would find, in order. */
  whereDapi: () => string[];
};

function payloadFiles(resourcesPath: string): { shim: string; bootstrap: string } {
  return {
    shim: join(resourcesPath, "cli", "bin", SHIM_NAME),
    bootstrap: join(resourcesPath, "cli", "bin", BOOTSTRAP_NAME),
  };
}

function binFiles(binDir: string): { shim: string; bootstrap: string } {
  return { shim: join(binDir, SHIM_NAME), bootstrap: join(binDir, BOOTSTRAP_NAME) };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Whether the shim is one Diffusion Studio wrote (and may replace). */
function isManagedShim(shimPath: string): boolean {
  return readText(shimPath)?.includes(SHIM_SIGNATURE) ?? false;
}

function sameFile(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
}

export function winCliStatus(env: WinCliEnv): CliStatus {
  const binDir = stableBinDir(rootForResources(env.resourcesPath));
  const { shim } = binFiles(binDir);
  const userPath = env.readUserPath();
  const onPath = userPath !== null && pathHasEntry(userPath, binDir);
  const present = readText(shim) !== null;
  if (onPath && present) return { installed: true, path: shim, managed: isManagedShim(shim), available: true };
  return { installed: false, path: null, managed: false, available: env.isPackaged };
}

/**
 * Whether a previous install lost its launcher files. A Squirrel
 * same-version reinstall wipes unrecognized dirs under the install root,
 * which removes our `bin` while the user-PATH entry — our proof the user
 * opted in — survives. Repair only recreates files we own.
 */
export function winCliNeedsRepair(env: WinCliEnv): boolean {
  if (!env.isPackaged || winCliStatus(env).installed) return false;
  const binDir = stableBinDir(rootForResources(env.resourcesPath));
  const userPath = env.readUserPath();
  return userPath !== null && pathHasEntry(userPath, binDir);
}

export function winInstallCli(env: WinCliEnv): CliInstallResult {
  if (!env.isPackaged) {
    return {
      status: "error",
      error: "Installing the CLI is only available in the packaged app. Use `npm run symlink:create` in development.",
    };
  }
  const installRoot = rootForResources(env.resourcesPath);
  const binDir = stableBinDir(installRoot);
  const payload = payloadFiles(env.resourcesPath);
  if (readText(payload.shim) === null || readText(payload.bootstrap) === null) {
    return { status: "error", error: "The packaged CLI files are missing. Reinstall Diffusion Studio to repair them." };
  }
  const bin = binFiles(binDir);
  const existing = readText(bin.shim);
  if (existing !== null && !existing.includes(SHIM_SIGNATURE)) {
    return { status: "error", error: `${bin.shim} is not managed by Diffusion Studio, so it was left alone.` };
  }
  for (const found of env.whereDapi()) {
    if (!sameFile(found, bin.shim)) {
      return { status: "error", error: `Another dapi is on PATH at ${found}. Remove it first.` };
    }
  }
  try {
    mkdirSync(binDir, { recursive: true });
    copyFileSync(payload.shim, bin.shim);
    copyFileSync(payload.bootstrap, bin.bootstrap);
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
  const userPath = env.readUserPath();
  if (userPath === null) {
    return { status: "error", error: "The user PATH could not be read, so the install was not finished." };
  }
  try {
    if (!pathHasEntry(userPath, binDir)) env.writeUserPath(addPathEntry(userPath, binDir));
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
  return { status: "installed" };
}

export function winUninstallCli(env: WinCliEnv): CliUninstallResult {
  const binDir = stableBinDir(rootForResources(env.resourcesPath));
  const bin = binFiles(binDir);
  const existing = readText(bin.shim);
  const userPath = env.readUserPath();
  const onPath = userPath !== null && pathHasEntry(userPath, binDir);
  if (existing === null && !onPath) return { status: "absent" };
  if (existing !== null && !existing.includes(SHIM_SIGNATURE)) {
    return { status: "error", error: `${bin.shim} is not managed by Diffusion Studio, so it was left alone.` };
  }
  try {
    if (existing !== null) {
      unlinkSync(bin.shim);
      try {
        unlinkSync(bin.bootstrap);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      // Only our own two files ever go in: drop the dir when it is empty,
      // leave it (and anything else in it) alone otherwise.
      try {
        if (readdirSync(binDir).length === 0) rmdirSync(binDir);
      } catch {
        // A foreign file or a race keeps the directory; the PATH entry below still goes.
      }
    }
    if (userPath !== null && onPath) env.writeUserPath(removePathEntry(userPath, binDir));
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
  return { status: "removed" };
}

function powershell(args: string[], input?: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    timeout: 15000,
  });
}

/** The production effects: the user PATH through .NET (which also broadcasts the change). */
export function realWinCliEnv(isPackaged: boolean, resourcesPath: string): WinCliEnv {
  return {
    isPackaged,
    resourcesPath,
    readUserPath: () => {
      try {
        const out = powershell(["-Command", "[Environment]::GetEnvironmentVariable('Path','User')"]).trim();
        return out;
      } catch {
        return null;
      }
    },
    writeUserPath: (value: string) => {
      // The value rides on stdin so quotes and parentheses in other
      // entries never meet the shell.
      powershell(["-Command", "[Environment]::SetEnvironmentVariable('Path', [Console]::In.ReadToEnd(), 'User')"], value);
    },
    whereDapi: () => {
      try {
        // `where` exits 1 with a "not found" notice when no dapi exists —
        // the normal case. Keep stdout piped for parsing, silence the rest.
        const out = execFileSync("where", ["dapi"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return out
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      } catch {
        return [];
      }
    },
  };
}
