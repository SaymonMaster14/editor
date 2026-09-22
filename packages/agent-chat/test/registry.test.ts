/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";

import { HARNESS_IDS, HARNESS_LABELS, isHarnessId } from "../src/protocol";
import { ClaudeHarness } from "../src/host/claude";
import { CodexHarness } from "../src/host/codex";
import { FakeHarness } from "../src/host/fake";
import { MuseHarness } from "../src/host/muse";
import { OpenCodeHarness } from "../src/host/opencode";

import type { HarnessCapabilities } from "../src/protocol";

const CAPABILITY_KEYS: (keyof HarnessCapabilities)[] = [
  "streaming",
  "images",
  "attachments",
  "mcp",
  "approvals",
  "questions",
  "interrupt",
  "resume",
  "models",
  "sessions",
  "sandbox",
  "readRoots",
  "writeRoots",
];

describe("harness registry", () => {
  it("labels every registered harness id", () => {
    for (const id of HARNESS_IDS) {
      expect(HARNESS_LABELS[id]).toMatch(/.+/);
      expect(isHarnessId(id)).toBe(true);
    }
    expect(isHarnessId("winamp")).toBe(false);
    expect(isHarnessId(null)).toBe(false);
  });

  it("exposes a full capability set from every harness", () => {
    for (const harness of [new ClaudeHarness(), new CodexHarness(), new FakeHarness(), new MuseHarness(), new OpenCodeHarness()]) {
      expect(HARNESS_IDS).toContain(harness.id);
      for (const key of CAPABILITY_KEYS) {
        expect(typeof harness.capabilities[key], `${harness.id}.${key}`).toBe("boolean");
      }
    }
  });

  it("reports capabilities from probe results", async () => {
    const info = await new FakeHarness().probe();
    expect(info.capabilities).toEqual(new FakeHarness().capabilities);
  });

  it("registers opencode and muse ids", () => {
    expect(HARNESS_IDS).toContain("opencode");
    expect(HARNESS_IDS).toContain("muse");
    expect(HARNESS_LABELS.opencode).toBe("OpenCode");
    expect(HARNESS_LABELS.muse).toBe("Muse Code");
  });
});
