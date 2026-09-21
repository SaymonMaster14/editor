/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Stable dapi bootstrap. Staged at resources/cli/bin and installed to
// <install root>\bin\dapi.js next to dapi.cmd; runs dependency-free on the
// app's own Electron in Node mode. Every run resolves the newest versioned
// bundle (app-X.Y.Z\resources\cli\dapi.js), so updates never strand the
// `dapi` on PATH. Mirrors versionDirs/currentBundlePath in
// @diffusionstudio/winpaths, which cannot be required from here.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.dirname(__dirname);

function versionDirs() {
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.toLowerCase().startsWith("app-"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
}

for (const dir of versionDirs()) {
  const bundle = path.join(root, dir, "resources", "cli", "dapi.js");
  if (!fs.existsSync(bundle)) continue;
  // argv is [exe, bootstrap, ...user args]; the bundle parses from index 2,
  // so it only needs its own path in the script slot.
  process.argv = [process.argv[0], bundle, ...process.argv.slice(2)];
  require(bundle);
  return;
}

console.error(`dapi: no Diffusion Studio install found under ${root} (reinstall the app to repair dapi)`);
process.exit(1);
