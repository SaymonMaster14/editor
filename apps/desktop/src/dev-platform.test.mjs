/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Plain-JS test (kept out of tsc's `include`, which covers .ts only) for the
// repo launcher helpers in scripts/dev-platform.mjs. No subprocess runs here:
// every runner is injected, and the only file system touched is a temp dir
// of fixture shims.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  isStaleViteCommand,
  killPid,
  npmLaunch,
  parseLsofPids,
  parsePortOwners,
  portOwners,
  resolveTool,
  shellArg,
  shellCommand,
} from "../../../scripts/dev-platform.mjs";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "dev-platform-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("resolveTool", () => {
  test("posix spawns the entry directly, without a shell", () => {
    expect(resolveTool(join("repo", "node_modules", ".bin"), "vite", { platform: "darwin" })).toEqual({
      file: join("repo", "node_modules", ".bin", "vite"),
      shell: false,
    });
  });

  test("windows picks the .cmd shim and shells it", () => {
    const bin = tempDir();
    writeFileSync(join(bin, "vite"), "#!/bin/sh\n");
    writeFileSync(join(bin, "vite.cmd"), "@echo off\n");
    expect(resolveTool(bin, "vite", { platform: "win32" })).toEqual({ file: join(bin, "vite.cmd"), shell: true });
  });

  test("windows runs a native .exe without a shell", () => {
    const bin = tempDir();
    writeFileSync(join(bin, "tool.exe"), "MZ");
    expect(resolveTool(bin, "tool", { platform: "win32" })).toEqual({ file: join(bin, "tool.exe"), shell: false });
  });
});

describe("shellCommand", () => {
  test("quotes the file so cmd.exe keeps spaced paths together", () => {
    expect(shellCommand("C:\\Users\\PC TRAB\\vite.cmd", [])).toBe('"C:\\Users\\PC TRAB\\vite.cmd"');
    expect(shellCommand("C:\\bin\\forge.cmd", ["start"])).toBe('"C:\\bin\\forge.cmd" start');
  });

  test("quotes only args that need it, doubling inner quotes", () => {
    expect(shellArg("--workspace=@diffusionstudio/cli")).toBe("--workspace=@diffusionstudio/cli");
    expect(shellArg("C:\\my dir\\x")).toBe('"C:\\my dir\\x"');
    expect(shellArg('say "hi"')).toBe('"say ""hi"""');
  });
});

describe("npmLaunch", () => {
  test("prefers the npm that launched this process, run on node without a shell", () => {
    const dir = tempDir();
    const cli = join(dir, "npm-cli.js");
    writeFileSync(cli, "");
    expect(npmLaunch({ npm_execpath: cli }, join(dir, "node"), { platform: "win32" })).toEqual({
      file: join(dir, "node"),
      prefix: [cli],
      shell: false,
    });
  });

  test("falls back to the npm beside the node binary", () => {
    const dir = tempDir();
    const cli = join(dir, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(dir, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(cli, "");
    const execPath = join(dir, "node.exe");
    expect(npmLaunch({}, execPath, { platform: "win32" })).toEqual({ file: execPath, prefix: [cli], shell: false });
  });

  test("last resort is the npm shim, shelled on windows only", () => {
    expect(npmLaunch({}, join(tempDir(), "node"), { platform: "win32" })).toEqual({
      file: "npm.cmd",
      prefix: [],
      shell: true,
    });
    expect(npmLaunch({}, join(tempDir(), "node"), { platform: "darwin" })).toEqual({
      file: "npm",
      prefix: [],
      shell: false,
    });
  });
});

describe("isStaleViteCommand", () => {
  test("windows matches a vite under this checkout despite case differences", () => {
    const command = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Dev\\REPO\\node_modules\\vite\\bin\\vite.js"';
    expect(isStaleViteCommand(command, "c:\\users\\dev\\repo", { platform: "win32" })).toBe(true);
  });

  test("windows rejects a vite from another checkout", () => {
    const command = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Other\\node_modules\\vite\\bin\\vite.js"';
    expect(isStaleViteCommand(command, "c:\\users\\dev\\repo", { platform: "win32" })).toBe(false);
  });

  test("windows rejects a non-vite process even under this checkout", () => {
    expect(isStaleViteCommand("C:\\users\\dev\\repo\\server.exe", "c:\\users\\dev\\repo", { platform: "win32" })).toBe(false);
  });

  test("posix matches exactly and tolerates a trailing slash on the root", () => {
    expect(isStaleViteCommand("/repo/node_modules/.bin/vite", "/repo/", { platform: "darwin" })).toBe(true);
    expect(isStaleViteCommand("/other/node_modules/.bin/vite", "/repo", { platform: "darwin" })).toBe(false);
  });
});

describe("parseLsofPids", () => {
  test("reads pid lines and drops blanks and garbage", () => {
    expect(parseLsofPids("123\n456\n")).toEqual([123, 456]);
    expect(parseLsofPids("\n  \nabc\n-1\n0\n789")).toEqual([789]);
  });
});

describe("parsePortOwners", () => {
  test("reads rows, defaults a missing command, drops bad pids", () => {
    const text = JSON.stringify([
      { pid: 11, command: "a" },
      { pid: 22 },
      { pid: -3, command: "x" },
      { pid: "9", command: "y" },
    ]);
    expect(parsePortOwners(text)).toEqual([
      { pid: 11, command: "a" },
      { pid: 22, command: "" },
    ]);
  });

  test("an idle port, a lone row, and garbage all behave", () => {
    expect(parsePortOwners("[]")).toEqual([]);
    expect(parsePortOwners("")).toEqual([]);
    expect(parsePortOwners("not json")).toEqual([]);
    expect(parsePortOwners(JSON.stringify({ pid: 7, command: "v" }))).toEqual([{ pid: 7, command: "v" }]);
  });
});

describe("portOwners", () => {
  test("windows asks powershell once for listeners and command lines", () => {
    const calls = [];
    const run = (file, args, opts) => {
      calls.push([file, args, opts]);
      return JSON.stringify([{ pid: 42, command: "vite" }]);
    };
    expect(portOwners(5173, { platform: "win32", run })).toEqual([{ pid: 42, command: "vite" }]);
    expect(calls).toHaveLength(1);
    const [file, args, opts] = calls[0];
    expect(file).toBe("powershell.exe");
    expect(args).toContain("-Command");
    expect(args[args.length - 1]).toContain("Get-NetTCPConnection");
    expect(args[args.length - 1]).toContain("5173");
    expect(opts.windowsHide).toBe(true);
  });

  test("windows failure or invalid port means unknown, not a throw", () => {
    expect(portOwners(5173, { platform: "win32", run: () => { throw new Error("no powershell"); } })).toEqual([]);
    let called = false;
    const run = () => { called = true; return "[]"; };
    expect(portOwners(99999, { platform: "win32", run })).toEqual([]);
    expect(called).toBe(false);
  });

  test("posix combines lsof pids with a ps lookup each", () => {
    const seen = [];
    const run = (file, args) => {
      seen.push(file);
      if (file === "lsof") return "11\n22\n";
      return " /repo/node_modules/.bin/vite \n";
    };
    expect(portOwners(5173, { platform: "darwin", run })).toEqual([
      { pid: 11, command: "/repo/node_modules/.bin/vite" },
      { pid: 22, command: "/repo/node_modules/.bin/vite" },
    ]);
    expect(seen).toEqual(["lsof", "ps", "ps"]);
  });

  test("posix lsof failure means an idle port", () => {
    expect(portOwners(5173, { platform: "darwin", run: () => { throw new Error("exit 1"); } })).toEqual([]);
  });
});

describe("killPid", () => {
  test("windows kills the tree, asking first and forcing on escalation", () => {
    const calls = [];
    const run = (file, args, opts) => { calls.push([file, args, opts]); };
    killPid(42, false, { platform: "win32", run });
    killPid(42, true, { platform: "win32", run });
    expect(calls[0][0]).toBe("taskkill");
    expect(calls[0][1]).toEqual(["/pid", "42", "/T"]);
    expect(calls[0][2].windowsHide).toBe(true);
    expect(calls[1][1]).toEqual(["/pid", "42", "/T", "/F"]);
  });

  test("posix signals the pid directly", () => {
    expect(() => killPid(2147483647, false, { platform: "darwin" })).toThrow();
  });
});
