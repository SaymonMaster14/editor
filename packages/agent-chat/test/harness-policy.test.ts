/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { claudePolicyFor } from "../src/host/claude.js";
import { codexPolicyFor, decideCodexCommand, decideCodexFileChange } from "../src/host/codex.js";
import { decideMspApproval, musePolicyFor } from "../src/host/muse.js";
import { decideAcpPermission, opencodePolicyFor } from "../src/host/opencode.js";
import { buildPolicy } from "../src/host/policy.js";

const sandbox = mkdtempSync(join(tmpdir(), "diffusion-harness-policy-"));
const project = join(sandbox, "project");
const approvedWrite = join(sandbox, "approved-write");
const outside = join(sandbox, "outside");
for (const dir of [project, approvedWrite, outside]) mkdirSync(dir, { recursive: true });

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const scoped = buildPolicy(project, { mode: "project", roots: [{ path: approvedWrite, write: true }] });
const full = buildPolicy(project, { mode: "full", roots: [] });

describe("codexPolicyFor", () => {
  it("defaults to the approval gate with the writable roots", () => {
    const policy = codexPolicyFor(scoped, project, false);
    expect(policy.full).toBe(false);
    expect(policy.approval).toBe("untrusted");
    expect(policy.writableRoots).toContain(scoped.projectRoot);
    expect(policy.writableRoots).toContain(scoped.roots[0]!.path);
  });

  it("selects full access only by opt-in, and honors an org refusal", () => {
    const accepted = codexPolicyFor(full, project, false);
    expect(accepted.full).toBe(true);
    expect(accepted.approval).toBe("never");
    const refused = codexPolicyFor(full, project, true);
    expect(refused.full).toBe(false);
    expect(refused.approval).toBe("untrusted");
  });

  it("fails closed when the host passes no policy", () => {
    expect(codexPolicyFor(undefined, project, false).full).toBe(false);
  });
});

describe("decideCodexFileChange", () => {
  it("accepts in-project changes and declines outside ones", () => {
    expect(decideCodexFileChange(scoped, project, [{ path: join(project, "a.tsx") }], true).approval).toBe("accept");
    const verdict = decideCodexFileChange(scoped, project, [{ path: join(outside, "a.tsx") }], true);
    expect(verdict.approval).toBe("decline");
    expect(verdict.reason).toContain("outside the writable roots");
  });

  it("asks when the item is unknown instead of guessing", () => {
    expect(decideCodexFileChange(scoped, project, [{ path: join(project, "a.tsx") }], false).approval).toBe("ask");
    expect(decideCodexFileChange(scoped, project, [], true).approval).toBe("ask");
    expect(decideCodexFileChange(scoped, project, [{}], true).approval).toBe("ask");
  });

  it("accepts everything under explicit full access", () => {
    expect(decideCodexFileChange(full, project, [{ path: join(outside, "a.tsx") }], true).approval).toBe("accept");
  });
});

describe("decideCodexCommand", () => {
  it("accepts in-project commands and declines outside writes", () => {
    expect(decideCodexCommand(scoped, project, `node ${join(project, "check.mjs")}`).approval).toBe("accept");
    const verdict = decideCodexCommand(scoped, project, `node ${join(outside, "evil.mjs")} > ${join(outside, "out.txt")}`);
    expect(verdict.approval).toBe("decline");
  });

  it("asks for unverifiable commands instead of silently allowing them", () => {
    expect(decideCodexCommand(scoped, project, "cd .. && del *").approval).toBe("ask");
    expect(decideCodexCommand(scoped, project, "powershell -EncodedCommand aGVsbG8=").approval).toBe("ask");
  });

  it("accepts everything under explicit full access", () => {
    expect(decideCodexCommand(full, project, "cd .. && del *").approval).toBe("accept");
  });

  it("accepts read-only shell commands even on paths outside the writable roots", () => {
    expect(decideCodexCommand(scoped, project, `type ${join(outside, "ref.txt")}`).approval).toBe("accept");
  });
});

describe("claudePolicyFor", () => {
  it("uses default mode with the policy attached", () => {
    const policy = claudePolicyFor(scoped, project, false);
    expect(policy.mode).toBe("default");
    expect(policy.access).toBe(scoped);
  });

  it("uses bypass only by opt-in, and honors an org refusal", () => {
    expect(claudePolicyFor(full, project, false).mode).toBe("bypassPermissions");
    expect(claudePolicyFor(full, project, true).mode).toBe("default");
  });

  it("fails closed when the host passes no policy", () => {
    expect(claudePolicyFor(undefined, project, false).mode).toBe("default");
  });
});

describe("musePolicyFor / decideMspApproval", () => {
  it("uses onRequest by default and allowAll only by opt-in", () => {
    expect(musePolicyFor(scoped, project).approvalMode).toBe("onRequest");
    expect(musePolicyFor(full, project).approvalMode).toBe("allowAll");
    expect(musePolicyFor(undefined, project).approvalMode).toBe("onRequest");
  });

  it("approves in-project file subjects and denies outside ones", () => {
    const inside = { toolName: "edit", subject: { kind: "fileAccess", path: join(project, "a.tsx") } };
    expect(decideMspApproval(scoped, project, inside)).toBe("allow");
    const denied = { toolName: "edit", subject: { kind: "fileAccess", path: join(outside, "a.tsx") } };
    expect(decideMspApproval(scoped, project, denied)).toBe("deny");
  });

  it("checks shell subjects against their command", () => {
    const clean = { toolName: "shell", subject: { kind: "shell", command: "npm run check" } };
    expect(decideMspApproval(scoped, project, clean)).toBe("allow");
    const dirty = { toolName: "shell", subject: { kind: "shell", command: `copy a ${join(outside, "b")}` } };
    expect(decideMspApproval(scoped, project, dirty)).toBe("deny");
  });

  it("asks on network subjects, unknown tools and pathless requests", () => {
    expect(decideMspApproval(scoped, project, { toolName: "fetch", subject: { kind: "network" } })).toBe("ask");
    expect(decideMspApproval(scoped, project, { toolName: "shell" })).toBe("ask");
    expect(decideMspApproval(scoped, project, {})).toBe("ask");
  });

  it("allows reads and everything under full access", () => {
    expect(decideMspApproval(scoped, project, { toolName: "read", subject: { kind: "fileAccess", path: join(outside, "x") } })).toBe("allow");
    expect(decideMspApproval(full, project, { toolName: "edit", subject: { kind: "fileAccess", path: join(outside, "x") } })).toBe("allow");
  });
});

describe("opencodePolicyFor / decideAcpPermission", () => {
  it("carries the policy, defaulting to project-only", () => {
    expect(opencodePolicyFor(scoped, project)).toBe(scoped);
    expect(opencodePolicyFor(undefined, project).mode).toBe("project");
  });

  it("approves in-project writes and refuses outside ones from raw input", () => {
    const inside = { toolCall: { toolCallId: "t", title: `Edit ${join(project, "a.tsx")}`, kind: "edit", rawInput: { file_path: join(project, "a.tsx") } } };
    expect(decideAcpPermission(scoped, project, inside).decision).toBe("allow");
    const denied = { toolCall: { toolCallId: "t", title: `Edit ${join(outside, "a.tsx")}`, kind: "edit", rawInput: { file_path: join(outside, "a.tsx") } } };
    expect(decideAcpPermission(scoped, project, denied).decision).toBe("deny");
  });

  it("approves reads and asks when there is no path evidence", () => {
    const read = { toolCall: { toolCallId: "t", title: "Read config", kind: "read", rawInput: { path: join(outside, "c") } } };
    expect(decideAcpPermission(scoped, project, read).decision).toBe("allow");
    const bare = { toolCall: { toolCallId: "t", title: "Delete everything", kind: "delete" } };
    expect(decideAcpPermission(scoped, project, bare).decision).toBe("ask");
  });

  it("allows everything under full access", () => {
    const denied = { toolCall: { toolCallId: "t", title: "x", kind: "delete", rawInput: { path: join(outside, "x") } } };
    expect(decideAcpPermission(full, project, denied).decision).toBe("allow");
  });
});
