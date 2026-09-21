/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One command to develop the desktop app from source. It:
//   1. builds the CLI, so a linked `dapi` (see symlink:create) runs the
//      latest code and the app's headless server matches it;
//   2. starts the web dev server (Vite on :5173), first reclaiming the port
//      from a Vite left behind by an earlier run that did not come down;
//   3. waits for that server, then launches Electron, which loads it.
// Ctrl-C tears the whole tree down.
//
// Windows notes: node_modules/.bin entries are .cmd shims there, so tools
// are resolved and shelled per file (see resolveTool); npm runs as node on
// its own cli.js to avoid the shell entirely; the stale-port check goes
// through PowerShell instead of lsof/ps, and teardown through taskkill /T.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isStaleViteCommand, isWindows, killPid, npmLaunch, portOwners, resolveTool, shellCommand } from "./dev-platform.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "node_modules", ".bin");
const DEV_PORT = 5173;

// The Electron binary comes from the `electron` package's install script.
// Some npm versions skip it, leaving node_modules without a runnable
// Electron; fetch it now rather than failing obscurely at launch.
const ELECTRON_BIN = join(ROOT, "node_modules", "electron", "dist", isWindows ? "electron.exe" : "electron");
if (!existsSync(ELECTRON_BIN)) {
  console.log("[dev:desktop] electron binary missing; downloading it…");
  execFileSync(process.execPath, [join(ROOT, "node_modules", "electron", "install.js")], { stdio: "inherit" });
}
const DEV_URL = `http://localhost:${DEV_PORT}`;
const children = [];
let shuttingDown = false;

function run(name, bin, args, cwd) {
  // Spawn the tool binary directly rather than via `npm run`, so the teardown
  // SIGTERM isn't dressed up as a "Lifecycle script failed" error by an npm
  // wrapper. Own process group (detached) so teardown reaches the tool *and*
  // its children (esbuild, electron) in one shot: a group signal on POSIX,
  // taskkill /T on Windows.
  const tool = resolveTool(BIN, bin);
  // Shelled children take one command line rather than an argv: Node does
  // not escape argv for cmd.exe (DEP0190), and these args are constants.
  const [file, spawnArgs] = tool.shell ? [shellCommand(tool.file, args), []] : [tool.file, args];
  const child = spawn(file, spawnArgs, { cwd, stdio: "inherit", detached: true, shell: tool.shell });
  child.on("exit", (code) => {
    if (shuttingDown) return;
    // A child dying on its own (e.g. Vite crashed) should bring the rest down.
    console.error(`\n[dev:desktop] ${name} exited (${code}); shutting down.`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      if (isWindows) {
        if (child.pid !== undefined) killPid(child.pid, true);
      } else {
        process.kill(-child.pid, "SIGTERM");
      }
    } catch {
      // Already gone.
    }
  }
  process.exit(code);
}

// Resolves once the dev server answers. Probes over HTTP against the same URL
// Electron loads, so we follow its host resolution (Vite binds localhost as
// IPv6 ::1) rather than guessing an address family.
function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = get(url, (res) => {
        res.destroy();
        resolve(); // Any response means the server is up.
      });
      req.once("error", () => {
        req.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Vite did not come up at ${url} in time`));
        } else {
          setTimeout(tryOnce, 200);
        }
      });
    };
    tryOnce();
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

// A blocking step that throws (a build fails) must not strand the servers
// it already started: take the tree down instead of dropping it orphaned.
process.on("uncaughtException", (err) => {
  console.error(`[dev:desktop] ${err.message}`);
  shutdown(1);
});

/**
 * Frees the dev port. A Vite left over from an earlier run of this repo
 * (Ctrl-C'd terminal, crashed Electron, a detached child) is killed and the
 * port awaited; anything else on the port is not ours to touch, so we say
 * what it is and stop.
 */
async function reclaimPort(port) {
  const owners = portOwners(port);
  if (!owners.length) return;
  for (const { pid, command } of owners) {
    if (!isStaleViteCommand(command, ROOT)) {
      console.error(`[dev:desktop] port ${port} is in use by another process (pid ${pid}): ${command || "unknown"}`);
      process.exit(1);
    }
    console.log(`[dev:desktop] port ${port} held by a stale vite (pid ${pid}); stopping it…`);
    try {
      killPid(pid, false);
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + 5000;
  while (portOwners(port).length) {
    if (Date.now() > deadline) {
      for (const { pid } of portOwners(port)) {
        try { killPid(pid, true); } catch { /* gone */ }
      }
      await new Promise((r) => setTimeout(r, 200));
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const npm = npmLaunch();
function npmRun(args) {
  const full = [...npm.prefix, ...args];
  if (npm.shell) {
    execFileSync(shellCommand(npm.file, full), { stdio: "inherit", shell: true });
  } else {
    execFileSync(npm.file, full, { stdio: "inherit" });
  }
}

// 1. Build the CLI (blocking) so `dapi` and the app agree on the latest code.
console.log("[dev:desktop] building CLI…");
npmRun(["run", "build", "--workspace=@diffusionstudio/cli"]);

// 2. Start the web dev server, on a port that is free.
await reclaimPort(DEV_PORT);
console.log("[dev:desktop] starting web dev server…");
run("web", "vite", [], join(ROOT, "apps", "web"));

// 3. Once it is up, build the desktop app (blocking, mirrors its `dev`
// script) and launch Electron, which loads :5173.
try {
  await waitForServer(DEV_URL);
} catch (err) {
  console.error(`[dev:desktop] ${err.message}`);
  shutdown(1);
}
console.log("[dev:desktop] building desktop app…");
npmRun(["run", "build", "--workspace=@diffusionstudio/desktop"]);
console.log("[dev:desktop] starting desktop app…");
run("desktop", "electron-forge", ["start"], join(ROOT, "apps", "desktop"));
