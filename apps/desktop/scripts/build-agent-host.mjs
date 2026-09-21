/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bundles the agent-chat host the same way on every OS: the esbuild JS API
// instead of a shell one-liner, so Windows cmd.exe never sees the single
// quotes and embedded banner it cannot parse.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");

await mkdir(join(desktopDir, "dist"), { recursive: true });
await build({
  entryPoints: [join(desktopDir, "..", "..", "packages", "agent-chat", "src", "bin.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["electron", "@anthropic-ai/claude-agent-sdk-*"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  outfile: join(desktopDir, "dist", "agent-host.mjs"),
  logLevel: "info",
});
