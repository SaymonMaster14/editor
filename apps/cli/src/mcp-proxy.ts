/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `dapi mcp`: the entry point for agents that only run stdio servers (Claude
// Desktop). A message pipe between stdio and the app's HTTP endpoint: each
// side is an SDK transport, so session handling and SSE framing are theirs,
// and nothing here looks inside a message. Stdout belongs to the protocol;
// anything for a human goes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_URL } from "@diffusionstudio/dapi";
import { APP_NAME, FAIL_WATCHDOG_MS, isAppDown, launchApp, ping, waitForApp } from "./cli-client";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type Closable = { close(): Promise<unknown> };

let shutdownArmed = false;

/**
 * Deferred proxy shutdown: never process.exit() synchronously out of a
 * transport callback — on Windows that races in-flight teardown and aborts
 * the process (see fail() in cli-client.ts). The first shutdown wins, peers
 * close best-effort, the loop drains, and the watchdog only fires on a hang.
 */
export function shutdown(code: number, peers: Closable[]): void {
  if (shutdownArmed) return;
  shutdownArmed = true;
  process.exitCode = code;
  for (const peer of peers) void peer.close().catch(() => {});
  setTimeout(() => process.exit(code), FAIL_WATCHDOG_MS).unref();
}

/** Exported for tests to reset between cases. */
export function resetShutdownForTest(): void {
  shutdownArmed = false;
}

/** Best-effort stdout EOF so the agent sees the session end. Broken pipes land here too. */
function endStdout(): void {
  try {
    if (!process.stdout.destroyed) process.stdout.end();
  } catch {
    // Already gone; the watchdog still exits.
  }
}

export async function runProxy(): Promise<void> {
  try {
    await ping();
  } catch (e) {
    if (!isAppDown(e)) throw e;
    // Cold-start the app in the background; where launch is unsupported the
    if (!(await launchApp(true))) {
      throw new Error(`${APP_NAME} is not running. Launch the app first, then retry.`);
    }
    await waitForApp();
  }

  const upstream = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const stdio = new StdioServerTransport();

  const fail = (error: Error): void => {
    console.error(`[dapi mcp] ${error.message}`);
    endStdout();
    shutdown(1, [upstream, stdio]);
  };

  upstream.onmessage = (message: JSONRPCMessage) => void stdio.send(message).catch(fail);
  stdio.onmessage = (message: JSONRPCMessage) => void upstream.send(message).catch(fail);
  upstream.onerror = (error) => console.error(`[dapi mcp] ${error.message}`);
  stdio.onerror = (error) => console.error(`[dapi mcp] ${error.message}`);
  // The app went away (quit, or the session was closed): the agent sees EOF.
  upstream.onclose = () => {
    endStdout();
    shutdown(0, [stdio]);
  };
  // The agent went away: tell the app, which ends the session.
  stdio.onclose = () => shutdown(0, [upstream]);

  await upstream.start();
  await stdio.start();
}
