/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Stages the main process's external dependencies into apps/desktop/runtime
// so electron-forge can ship them as an app resource (Contents/Resources/
// runtime). A packaged app has no node_modules of its own: everything else
// is bundled into dist/main.js, but esbuild (native binary) and the babel
// toolchain stay external and are loaded from here at run time (see `load`
// in src/projects.ts). The staged layout:
//   runtime/package.json   the externals, pinned to the workspace's versions
//   runtime/node_modules   a fresh `npm install --omit=dev` of them
//
// The list of externals is read from the build:main script so that it cannot
// drift from what the bundle actually leaves unresolved.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = join(desktopDir, "runtime");
const require = createRequire(join(desktopDir, "package.json"));

const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
const externals = [...pkg.scripts["build:main"].matchAll(/--external:(\S+)/g)]
  .map((match) => match[1])
  // Electron is provided by the host binary, not installed.
  .filter((name) => name !== "electron");

// Pin what the workspace has installed (and was tested against), not the
// ranges in package.json.
const dependencies = Object.fromEntries(
  externals.map((name) => [name, require(`${name}/package.json`).version]),
);

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

writeFileSync(
  join(stageDir, "package.json"),
  // allowScripts keeps esbuild's postinstall running even on machines whose npm
  // config gates install scripts: without the real binary at esbuild/bin the
  // staged runtime would differ from upstream's macOS staging.
  JSON.stringify(
    { name: "desktop-runtime", private: true, dependencies, allowScripts: { esbuild: true } },
    null,
    2,
  ),
);

// On Windows npm is a .cmd shim, which only runs under an interpreter.
const npmCmd = ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"];
// A nested npm must not inherit the outer run's config: npm exposes it as
// npm_config_* env vars, which the child parses as flags (e.g. a stale
// allow-scripts value fails the install with EALLOWSCRIPTS). The staged
// dependencies are all public, so a default config is correct.
const npmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("npm_config_")),
);
if (process.platform === "win32") {
  execFileSync("cmd.exe", ["/d", "/s", "/c", "npm", ...npmCmd], {
    cwd: stageDir,
    stdio: "inherit",
    env: npmEnv,
  });
} else {
  execFileSync("npm", npmCmd, {
    cwd: stageDir,
    stdio: "inherit",
    env: npmEnv,
  });
}

// Mach-O files inside Resources are not reached by the app-bundle signing
// pass, and notarization rejects unsigned executables; sign them here.
// esbuild's postinstall hard-links the native binary over its bin/esbuild
// shim, so the same executable can sit in two places.
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]);
function isMachO(path) {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    return readSync(fd, header, 0, 4, 0) === 4 && MACHO_MAGIC.has(header.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

const esbuildDir = join(stageDir, "node_modules", "@esbuild");
const binaries = [
  join(stageDir, "node_modules", "esbuild", "bin", "esbuild"),
  ...(existsSync(esbuildDir) ? readdirSync(esbuildDir).map((name) => join(esbuildDir, name, "bin", "esbuild")) : []),
].filter((path) => existsSync(path) && isMachO(path));

if (process.platform === "darwin" && !process.env.SKIP_SIGN) {
  const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  const identity = identities.match(/"(Developer ID Application: [^"]+)"/)?.[1];
  if (identity) {
    for (const bin of binaries) {
      execFileSync("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", identity, bin], {
        stdio: "inherit",
      });
    }
  } else {
    console.warn("stage-runtime: no Developer ID identity found, leaving esbuild binaries unsigned");
  }
}

console.log(`stage-runtime: staged ${externals.join(", ")} at ${stageDir}`);
