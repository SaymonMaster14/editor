/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Where the app serves MCP over Streamable HTTP: a fixed loopback port, so
// the URL is the same on every machine and can be written into an agent's
// config once. 3274 spells "dapi" on a phone keypad. Loopback only; no token
// — the server checks the Host header, which is what keeps browser pages
// out, and anything else running as the user can already reach the app.
export const MCP_HOST = "127.0.0.1";
export const MCP_PATH = "/mcp";

/**
 * `DIFFUSION_MCP_PORT` moves the server (and the CLI, which reads the same
 * constants) off the default, so a development build serves beside the
 * installed app instead of failing its bind. The renderer bundle includes
 * this module too, where `process` does not exist — hence the guard.
 */
function mcpPort(): number {
  const raw = typeof process === "undefined" ? undefined : process.env.DIFFUSION_MCP_PORT;
  if (raw === undefined || raw.trim() === "") return 3274;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DIFFUSION_MCP_PORT must be a port 1-65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

export const MCP_PORT = mcpPort();
export const MCP_URL = `http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}`;
