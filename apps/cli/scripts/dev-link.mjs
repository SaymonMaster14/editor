/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Development `dapi` for this checkout (the `symlink:create` /
// `symlink:remove` scripts), without assuming Homebrew. macOS keeps its
// link into /opt/homebrew/bin; Windows cannot symlink without privileges,
// so it gets a dapi.cmd shim beside the bundle that runs it on the
// workspace's own Electron in Node mode — no separate Node install, no
// admin, and nothing outside the checkout.

import { lstat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(cliDir, "dist", "index.js");
const DEV_LINK_PATH = "/opt/homebrew/bin/dapi";
const removing = process.argv.includes("--remove");

if (process.platform === "win32") {
  const shim = join(cliDir, "dist", "dapi.cmd");
  if (removing) {
    await unlink(shim).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    console.log(`dev-link: removed ${shim}`);
    process.exit(0);
  }
  const electron = join(cliDir, "..", "..", "node_modules", "electron", "dist", "electron.exe");
  await writeFile(
    shim,
    ["@echo off", "chcp 65001 >nul", "set ELECTRON_RUN_AS_NODE=1", `"${electron}" "%~dp0index.js" %*`, ""].join(
      "\r\n",
    ),
  );
  console.log(`dev-link: wrote ${shim}`);
  console.log("dev-link: run it directly, or put apps\\cli\\dist on PATH for this checkout.");
  process.exit(0);
}

if (removing) {
  await unlink(DEV_LINK_PATH).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  console.log(`dev-link: removed ${DEV_LINK_PATH}`);
  process.exit(0);
}

await unlink(DEV_LINK_PATH).catch((e) => {
  if (e.code !== "ENOENT") throw e;
});
const existing = await lstat(bundle).catch(() => null);
if (!existing) {
  console.error("dev-link: build the CLI first (`npm run build` in apps/cli).");
  process.exit(1);
}
await symlink(bundle, DEV_LINK_PATH);
console.log(`dev-link: linked ${DEV_LINK_PATH} -> ${bundle}`);
