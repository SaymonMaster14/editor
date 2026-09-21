/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn as spawnMock } from "node:child_process";
import { EventEmitter } from "node:events";
import { arch, platform, release } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIssueBody, report } from "./report";

import type { LogEntry } from "@diffusionstudio/dapi";
import type { MainContext } from "../handler";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ctx = (entries: LogEntry[] = []): MainContext => ({
  signal: new AbortController().signal,
  logs: () => entries,
  version: "0.205.2-test",
});

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { on: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
}

function mockGh(): { spawn: ReturnType<typeof vi.fn>; child: MockChild } {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on: vi.fn(), end: vi.fn() };
  const spawn = vi.mocked(spawnMock);
  spawn.mockClear();
  spawn.mockReturnValue(child as never);
  return { spawn, child };
}

describe("buildIssueBody", () => {
  it("renders body, repro, environment, and logs sections", () => {
    const body = buildIssueBody({
      body: "Export freezes at 50%.",
      commands: ["dapi open C:\\demo", "dapi export scene1 -o C:\\demo\\out"],
      logs: ["[info] Export 50%", "[error] EXPORT failed"],
      version: "0.205.2-test",
    });
    expect(body).toContain("Export freezes at 50%.");
    expect(body).toContain("## Repro");
    expect(body).toContain("```sh\ndapi open C:\\demo\ndapi export scene1 -o C:\\demo\\out\n```");
    expect(body).toContain("## Environment");
    expect(body).toContain(`| platform | ${platform()} ${release()} (${arch()}) |`);
    expect(body).toContain("| app | 0.205.2-test |");
    expect(body).toContain("## App logs");
    expect(body).toContain("[error] EXPORT failed");
  });

  it("omits empty sections but always reports the environment", () => {
    const body = buildIssueBody({ logs: [], version: "0.205.2-test" });
    expect(body).not.toContain("## Repro");
    expect(body).not.toContain("## App logs");
    expect(body).toContain("## Environment");
    expect(body).toContain("| platform |");
  });
});

describe("report", () => {
  it("rejects a blank title without spawning gh", async () => {
    const { spawn } = mockGh();
    await expect(report({ title: "   " }, ctx())).rejects.toMatchObject({ code: "invalid-input" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("resolves gh from PATH without a shell and pipes the body over stdin", async () => {
    const { spawn, child } = mockGh();
    process.nextTick(() => {
      child.stdout.emit("data", "https://github.com/diffusionstudio/editor/issues/123\n");
      child.emit("close", 0);
    });
    const { url } = await report({ title: "Windows freeze", body: "details" }, ctx());
    expect(url).toBe("https://github.com/diffusionstudio/editor/issues/123");
    expect(spawn).toHaveBeenCalledTimes(1);
    // Bare "gh" resolves via PATHEXT on Windows; no shell, no quoting games.
    expect(spawn.mock.calls[0]![0]).toBe("gh");
    expect(spawn.mock.calls[0]![1]).toEqual([
      "issue",
      "create",
      "--repo",
      "diffusionstudio/editor",
      "--title",
      "Windows freeze",
      "--body-file",
      "-",
    ]);
    expect(spawn.mock.calls[0]![2]).toBeUndefined();
    const piped = child.stdin.end.mock.calls[0]![0] as string;
    expect(piped).toContain("details");
    expect(piped).toContain("| platform |");
  });

  it("maps a missing gh to the install hint instead of a raw ENOENT", async () => {
    const enoent = () => Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    const first = mockGh();
    process.nextTick(() => first.child.emit("error", enoent()));
    await expect(report({ title: "x" }, ctx())).rejects.toMatchObject({ code: "unsupported" });
    const second = mockGh();
    process.nextTick(() => second.child.emit("error", enoent()));
    await expect(report({ title: "x" }, ctx())).rejects.toThrow("gh auth login");
  });

  it("surfaces gh failures with stderr, and rejects non-URL output", async () => {
    const { child } = mockGh();
    process.nextTick(() => {
      child.stderr.emit("data", "Not authenticated");
      child.emit("close", 1);
    });
    await expect(report({ title: "x" }, ctx())).rejects.toThrow("Not authenticated");

    const again = mockGh();
    process.nextTick(() => {
      again.child.stdout.emit("data", "created, but no url printed");
      again.child.emit("close", 0);
    });
    await expect(report({ title: "x" }, ctx())).rejects.toThrow("did not print an issue URL");
  });

  it("attaches the recent log tail to the filed body", async () => {
    const { child } = mockGh();
    process.nextTick(() => {
      child.stdout.emit("data", "https://github.com/diffusionstudio/editor/issues/1\n");
      child.emit("close", 0);
    });
    const entries: LogEntry[] = [{ ts: 7, level: "error", message: "boom", source: "" }];
    await report({ title: "x", logs: 10 }, ctx(entries));
    expect(child.stdin.end.mock.calls[0]![0]).toContain("boom");
  });
});
