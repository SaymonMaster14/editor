/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Builds the dapi CLI the same way on every OS: the esbuild JS API instead
// of the binary plus `chmod`, so Windows needs no shell utilities. The exec
// bit is set through fs, which is a no-op where it means nothing.

import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(cliDir, "dist", "index.js");

await mkdir(join(cliDir, "dist"), { recursive: true });
await build({
  entryPoints: [join(cliDir, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  logLevel: "info",
});
await chmod(outfile, 0o755);
