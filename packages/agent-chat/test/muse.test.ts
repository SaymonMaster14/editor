/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MuseHarness } from "../src/host/muse";

import type { ChatEvent, HarnessInfo } from "../src/protocol";
import type { HostEnv } from "../src/host/env";
import type { Emit } from "../src/host/harness";

const here = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";

let counter = 0;

function fixtureBinary(dir: string): string {
  if (IS_WINDOWS) return join(here, "fixtures", "fake-msp.cmd");
  const copy = join(dir, "fake-msp.cjs");
  copyFileSync(join(here, "fixtures", "fake-msp.cjs"), copy);
  chmodSync(copy, 0o755);
  return copy;
}

function makeEnv(auth: boolean): { host: HostEnv; dir: string; logFile: string } {
  const dir = join(tmpdir(), `muse-test-${process.pid}-${counter++}`);
  mkdirSync(join(dir, "muse"), { recursive: true });
  if (auth) writeFileSync(join(dir, "muse", "auth.json"), JSON.stringify({ providers: { meta: { access_token: "x" } } }), "utf8");
  const logFile = join(dir, "msp.log");
  writeFileSync(logFile, "", "utf8");
  const host: HostEnv = {
    env: { ...process.env, XDG_CONFIG_HOME: dir, FAKE_MSP_LOG: logFile, DIFFUSION_MUSE_PATH: fixtureBinary(dir) } as Record<string, string>,
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

describe("MuseHarness", () => {
  it("probes ready with the server's model list", async () => {
    const { host } = makeEnv(true);
    const harness = new MuseHarness();
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
    const harness = new MuseHarness();
    const noAuth = makeEnv(false);
    expect((await harness.probe(noAuth.host, new AbortController().signal)).status).toBe("signed-out");
    const bare: HostEnv = { env: { PATH: "", XDG_CONFIG_HOME: noAuth.dir }, extraDirs: [] };
    expect((await harness.probe(bare, new AbortController().signal)).status).toBe("not-installed");
  });

  it("sends a turn: streamed text, tool item, resume cursor", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new MuseHarness();
    const opened = collector();
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: opened.emit });
    expect(session.resume).toEqual({ muse: { sessionId: "ses_test" } });
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
    expect(logLines(logFile).join("\n")).toContain("mcp null");
    await session.close();
  });

  it("switches models between turns", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new MuseHarness();
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: () => {} });
    await session.send("hello", "fake/b", () => {});
    expect(logLines(logFile).join("\n")).toContain("model fake/b");
    await session.close();
  });

  it("injects the diffusion MCP server per session", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new MuseHarness();
    const session = await harness.open({
      cwd: dir,
      model: "fake/a",
      mcp: { name: "diffusion", url: "http://127.0.0.1:9/mcp" },
      env: host,
      emit: () => {},
    });
    const mcpLine = logLines(logFile).find((line) => line.startsWith("mcp ")) ?? "";
    expect(mcpLine).toContain('"transport":"streamableHttp"');
    expect(mcpLine).toContain("http://127.0.0.1:9/mcp");
    await session.close();
  });

  it("routes user questions through answers", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new MuseHarness();
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: () => {} });
    const pending = session.send("ASK-QUESTION", "fake/a", (event) => {
      if (event.type === "request.opened") session.respond(event.request.id, { answers: { color: ["Blue"] } });
    });
    const outcome = await pending;
    expect(outcome).toEqual({ status: "completed" });
    expect(logLines(logFile).join("\n")).toContain('"selectedLabel":"Blue"');
    await session.close();
  });

  it("auto-decides approvals so allowAll turns never hang", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new MuseHarness();
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: () => {} });
    const outcome = await session.send("ASK-APPROVAL", "fake/a", () => {});
    expect(outcome).toEqual({ status: "completed" });
    expect(logLines(logFile).join("\n")).toContain("decide ap_1 yes");
    await session.close();
  });

  it("reports failed turns with the server's message", async () => {
    const { host, dir } = makeEnv(true);
    const harness = new MuseHarness();
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: () => {} });
    const outcome = await session.send("FAIL-ME", "fake/a", () => {});
    expect(outcome).toEqual({ status: "failed", error: "boom" });
    await session.close();
  });

  it("interrupts a running turn", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new MuseHarness();
    const session = await harness.open({ cwd: dir, model: "fake/a", mcp: null, env: host, emit: () => {} });
    const pending = session.send("INTERRUPT-ME", "fake/a", () => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.interrupt();
    expect(await pending).toEqual({ status: "interrupted" });
    expect(logLines(logFile)).toContain("interrupt");
    await session.close();
  });

  it("resumes a previous session, else starts fresh with a notice", async () => {
    const { host, dir, logFile } = makeEnv(true);
    const harness = new MuseHarness();
    const session = await harness.open({
      cwd: dir,
      model: "fake/a",
      resume: { muse: { sessionId: "ses_old" } },
      mcp: null,
      env: host,
      emit: () => {},
    });
    expect(session.resume).toEqual({ muse: { sessionId: "ses_old" } });
    expect(logLines(logFile).join("\n")).toContain("resume ses_old");
    await session.close();

    const opened = collector();
    const fresh = await harness.open({
      cwd: dir,
      model: "fake/a",
      resume: { muse: { sessionId: "ses_missing" } },
      mcp: null,
      env: host,
      emit: opened.emit,
    });
    expect(fresh.resume).toEqual({ muse: { sessionId: "ses_test" } });
    expect(opened.events.some((event) => event.type === "item.completed" && event.item.kind === "notice")).toBe(true);
    await fresh.close();
  });
});
