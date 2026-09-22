/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OpenCodeHarness } from "../src/host/opencode";

import type { ChatEvent, HarnessInfo } from "../src/protocol";
import type { HostEnv } from "../src/host/env";
import type { Emit } from "../src/host/harness";

const here = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";

let counter = 0;

function fixtureBinary(dir: string): string {
  if (IS_WINDOWS) return join(here, "fixtures", "fake-acp.cmd");
  const copy = join(dir, "fake-acp.cjs");
  copyFileSync(join(here, "fixtures", "fake-acp.cjs"), copy);
  chmodSync(copy, 0o755);
  return copy;
}

function makeEnv(auth: boolean): { host: HostEnv; dir: string; logFile: string } {
  const dir = join(tmpdir(), `opencode-test-${process.pid}-${counter++}`);
  mkdirSync(join(dir, "opencode"), { recursive: true });
  if (auth) writeFileSync(join(dir, "opencode", "auth.json"), JSON.stringify({ test: { token: "x" } }), "utf8");
  const logFile = join(dir, "acp.log");
  writeFileSync(logFile, "", "utf8");
  const host: HostEnv = {
    env: { ...process.env, XDG_DATA_HOME: dir, FAKE_ACP_LOG: logFile, DIFFUSION_OPENCODE_PATH: fixtureBinary(dir) } as Record<string, string>,
    extraDirs: [],
  };
  return { host, dir, logFile };
}

function logLines(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean);
}

function collector() {
  const events: ChatEvent[] = [];
  const emit: Emit = (event) => events.push(event);
  return { events, emit };
}

function assistantText(events: ChatEvent[]): string {
  return events
    .filter((event): event is Extract<ChatEvent, { type: "item.delta" }> => event.type === "item.delta")
    .map((event) => event.text)
    .join("");
}

describe("OpenCodeHarness", () => {
  it("probes ready with the server's model list", async () => {
    const { host } = makeEnv(true);
    const harness = new OpenCodeHarness();
    const info: HarnessInfo = await harness.probe(host, new AbortController().signal);
    expect(info.status).toBe("ready");
    expect(info.version).toBe("9.9.9");
    expect(info.models).toEqual([
      { id: "fake/a", label: "Fake A" },
      { id: "fake/b", label: "Fake B" },
    ]);
    expect(info.defaultModel).toBe("fake/a");
    expect(info.capabilities.streaming).toBe(true);
  });

  it("probes signed-out without credentials, not-installed without a binary", async () => {
    const harness = new OpenCodeHarness();
    const noAuth = makeEnv(false);
    expect((await harness.probe(noAuth.host, new AbortController().signal)).status).toBe("signed-out");
    const bare: HostEnv = { env: { PATH: "", XDG_DATA_HOME: noAuth.dir }, extraDirs: [] };
    expect((await harness.probe(bare, new AbortController().signal)).status).toBe("not-installed");
  });

  it("sends a turn: streamed text, tool item, resume cursor", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new OpenCodeHarness();
    const opened = collector();
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: opened.emit });
    expect(session.resume).toEqual({ opencode: { sessionId: "ses_test" } });
    const turned = collector();
    const outcome = await session.send("hello", "fake/a", turned.emit);
    expect(outcome).toEqual({ status: "completed" });
    expect(assistantText(turned.events)).toBe("Hello there");
    const tools = turned.events.filter(
      (event): event is Extract<ChatEvent, { type: "item.completed" }> => event.type === "item.completed" && "item" in event && event.item.kind === "tool",
    );
    expect(tools).toHaveLength(1);
    const tool = tools[0]!.item;
    expect(tool.kind).toBe("tool");
    if (tool.kind !== "tool") throw new Error("expected a tool item");
    expect(tool.title).toBe("read");
    expect(tool.output).toBe("file contents");
    expect(tool.status).toBe("done");
    expect(logLines(logFile).join("\n")).toContain("mcp []");
    await session.close();
  });

  it("switches models between turns", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new OpenCodeHarness();
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: () => {} });
    await session.send("hello", "fake/b", () => {});
    expect(logLines(logFile).join("\n")).toContain("model fake/b");
    await session.close();
  });

  it("injects the diffusion MCP server per session", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new OpenCodeHarness();
    const session = await harness.open({
      cwd: dir,
      model: "fake/a",
      mcp: { name: "diffusion", url: "http://127.0.0.1:9/mcp" },
      env: host,
      emit: () => {},
    });
    const mcpLine = logLines(logFile).find((line) => line.startsWith("mcp ")) ?? "";
    expect(mcpLine).toContain('"type":"http"');
    expect(mcpLine).toContain("http://127.0.0.1:9/mcp");
    await session.close();
  });

  it("routes permission requests through questions", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new OpenCodeHarness();
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: () => {} });
    const pending = session.send("ASK-PERMISSION", "fake/b", (event) => {
      if (event.type === "request.opened") session.respond(event.request.id, { answers: { tc_1: ["Allow"] } });
    });
    const outcome = await pending;
    expect(outcome).toEqual({ status: "completed" });
    expect(logLines(logFile).join("\n")).toContain('"outcome":"selected","optionId":"allow"');
    await session.close();
  });

  it("auto-allows in-project writes and refuses outside ones", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new OpenCodeHarness();
    const opened: string[] = [];
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: (event) => void opened.push(event.type) });
    const inside = await session.send(`ASK-PERMISSION-ALLOW\n${join(dir, "note.txt")}`, "fake/b", (event) => void opened.push(event.type));
    expect(inside).toEqual({ status: "completed" });
    const outside = join(tmpdir(), `acp-outside-${process.pid}.txt`);
    const refused = await session.send(`ASK-PERMISSION-DENY\n${outside}`, "fake/b", (event) => void opened.push(event.type));
    expect(refused).toEqual({ status: "completed" });
    const log = logLines(logFile).join("\n");
    expect(log).toContain('"outcome":"selected","optionId":"allow"');
    expect(log).toContain('"outcome":"cancelled"');
    expect(opened).not.toContain("request.opened");
    await session.close();
  });

  it("auto-allows everything under full access", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new OpenCodeHarness();
    const opened: string[] = [];
    const session = await harness.open({
      cwd: dir,
      model: "fake/a",
      mcp: null,
      access: { mode: "full", projectRoot: dir, roots: [] },
      env: host,
      emit: (event) => void opened.push(event.type),
    });
    const outcome = await session.send("ASK-PERMISSION", "fake/b", (event) => void opened.push(event.type));
    expect(outcome).toEqual({ status: "completed" });
    expect(logLines(logFile).join("\n")).toContain('"outcome":"selected","optionId":"allow"');
    expect(opened).not.toContain("request.opened");
    await session.close();
  });

  it("interrupts a running turn", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new OpenCodeHarness();
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: () => {} });
    const pending = session.send("INTERRUPT-ME", "fake/a", () => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.interrupt();
    expect(await pending).toEqual({ status: "interrupted" });
    expect(logLines(logFile)).toContain("cancel");
    await session.close();
  });

  it("resumes a previous session", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new OpenCodeHarness();
    const session = await harness.open({
      cwd: dir,
      model: "fake/a",
      resume: { opencode: { sessionId: "ses_old" } },
      mcp: null,
      env: host,
      emit: () => {},
    });
    expect(session.resume).toEqual({ opencode: { sessionId: "ses_old" } });
    expect(logLines(logFile).join("\n")).toContain("load ses_old");
    await session.close();
  });
});
