/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const SHIM = join(testDir, "..", "staged-cli", "dapi.cmd");
const BOOTSTRAP = join(testDir, "..", "staged-cli", "dapi.js");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dapi-launcher-"));
  tempDirs.push(dir);
  return dir;
}

/** Fake install: version dirs with marker bundles, real bootstrap in bin/. */
function fakeInstall(versions: string[]): { root: string; bootstrap: string } {
  const root = tempDir();
  for (const version of versions) {
    const dir = join(root, `app-${version}`, "resources", "cli");
    mkdirSync(dir, { recursive: true });
    // Marker bundle: reports which version ran, its argv, and the script slot.
    writeFileSync(
      join(dir, "dapi.js"),
      `console.log(JSON.stringify({ version: "${version}", args: process.argv.slice(2), script: process.argv[1] }));\n`,
    );
  }
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const bootstrap = join(bin, "dapi.js");
  copyFileSync(BOOTSTRAP, bootstrap);
  return { root, bootstrap };
}

function runBootstrap(bootstrap: string, args: string[]): { stdout: string; code: number | null } {
  try {
    const stdout = execFileSync(process.execPath, [bootstrap, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number | null };
    return { stdout: String(err.stdout ?? ""), code: err.status ?? null };
  }
}

describe("dapi bootstrap", () => {
  test("runs the newest versioned bundle with the user args intact", () => {
    const { bootstrap } = fakeInstall(["0.205.2", "0.205.10"]);
    const { stdout, code } = runBootstrap(bootstrap, ["mcp", "--flag", "spaced arg"]);
    expect(code).toBe(0);
    const ran = JSON.parse(stdout) as { version: string; args: string[]; script: string };
    expect(ran.version).toBe("0.205.10");
    expect(ran.args).toEqual(["mcp", "--flag", "spaced arg"]);
    expect(ran.script).toContain(join("app-0.205.10", "resources", "cli", "dapi.js"));
  });

  test("skips a version dir left behind without a bundle", () => {
    const { bootstrap } = fakeInstall(["0.205.2"]);
    mkdirSync(join(dirname(bootstrap), "..", "app-0.205.3", "resources"), { recursive: true });
    const { stdout, code } = runBootstrap(bootstrap, []);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { version: string }).version).toBe("0.205.2");
  });

  test("fails with a repair hint when no bundle exists", () => {
    const { bootstrap } = fakeInstall([]);
    const { stdout, code } = runBootstrap(bootstrap, ["--version"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
  });
});

describe("dapi shim", () => {
  test("invokes its sibling bootstrap on the install stub in node mode", () => {
    const shim = readFileSync(SHIM, "utf8");
    // The shim and bootstrap couple through the sibling layout: the shim
    // must exec the dapi.js next to it, on the exe above it, with the
    // node-mode flag the bundle needs and the app path cold-start reads.
    expect(shim).toContain('"%~dp0dapi.js"');
    expect(shim).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(shim).toContain("DIFFUSION_APP_PATH");
    expect(shim).toContain("Diffusion Studio.exe");
    expect(shim).toContain("%*");
    expect(shim).toContain("diffusion-studio-dapi-shim");
  });
});
