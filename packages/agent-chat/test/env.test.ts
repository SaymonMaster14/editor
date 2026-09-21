/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { envGet, resolveBinary, which } from "../src/host/env";

const IS_WINDOWS = process.platform === "win32";
const winOnly = it.runIf(IS_WINDOWS);

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fixtureDir(file: string): string {
  const dir = mkdtempSync(join(tmpdir(), "env-case-"));
  dirs.push(dir);
  writeFileSync(join(dir, file), "x");
  return dir;
}

describe("envGet", () => {
  it("returns the exact match", () => {
    expect(envGet({ PATH: "/a" }, "PATH")).toBe("/a");
  });

  it("returns undefined when the key is absent", () => {
    expect(envGet({}, "PATH")).toBeUndefined();
  });

  winOnly("reads case-insensitively on Windows", () => {
    expect(envGet({ Path: "C:\\bin" }, "PATH")).toBe("C:\\bin");
    expect(envGet({ pathext: ".EXE" }, "PATHEXT")).toBe(".EXE");
  });

  winOnly("prefers the exact match when both casings exist", () => {
    expect(envGet({ PATH: "upper", Path: "mixed" }, "PATH")).toBe("upper");
  });
});

describe("which with OS-cased keys", () => {
  winOnly("finds a binary through a mixed-case Path key (GUI-launched app)", () => {
    const dir = fixtureDir("probe-tool.exe");
    const found = which("probe-tool", { env: { Path: dir }, extraDirs: [] });
    expect(found).toBe(join(dir, "probe-tool.exe"));
  });

  winOnly("finds a binary through an uppercase PATH key (npm-launched)", () => {
    const dir = fixtureDir("probe-tool.exe");
    const found = which("probe-tool", { env: { PATH: dir }, extraDirs: [] });
    expect(found).toBe(join(dir, "probe-tool.exe"));
  });

  winOnly("uses a mixed-case PathExt for extension probing", () => {
    const dir = fixtureDir("probe-tool.exe");
    const found = which("probe-tool", { env: { Path: dir, PathExt: ".EXE" }, extraDirs: [] });
    expect(found).toBe(join(dir, "probe-tool.exe"));
  });

  winOnly("returns null when the binary is nowhere", () => {
    const dir = fixtureDir("other.exe");
    expect(which("probe-tool", { env: { Path: dir }, extraDirs: [] })).toBeNull();
  });
});

describe("resolveBinary with OS-cased keys", () => {
  winOnly("honors a mixed-case override", () => {
    const dir = fixtureDir("custom-codex.exe");
    const target = join(dir, "custom-codex.exe");
    expect(resolveBinary("codex", { env: { diffusion_codex_path: target }, extraDirs: [] })).toBe(target);
  });
});
