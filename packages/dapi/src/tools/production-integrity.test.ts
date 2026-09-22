/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { productionIntegrity } from "./production-integrity";

describe("production_integrity", () => {
  const input = productionIntegrity.input;

  it("parses a bare check and a check with a scene id", () => {
    expect(input.parse({ op: "check" })).toMatchObject({ op: "check" });
    expect(input.parse({ op: "check", id: "intro" }).id).toBe("intro");
  });

  it("parses a full escalation receipt and leaves the capability unset", () => {
    const args = input.parse({
      op: "record-escalation",
      asset: "sim/fire.mp4",
      tool: "blender",
      reason: "fluid simulation Diffusion cannot represent",
      scope: "element",
    });
    expect(args).toMatchObject({ op: "record-escalation", scope: "element" });
    expect(args.missingCapability).toBeUndefined();
    expect(input.parse({ op: "record-escalation", asset: "a", tool: "t", reason: "r", scope: "footage" }).scope).toBe("footage");
  });

  it("rejects unknown ops and scopes", () => {
    expect(input.safeParse({ op: "judge" }).success).toBe(false);
    expect(input.safeParse({ op: "record-escalation", asset: "a", tool: "t", reason: "r", scope: "program" }).success).toBe(false);
  });

  it("accepts the check output shape with and without a dominant asset", () => {
    const scene = {
      id: "intro",
      duration: 12,
      stats: { nodes: 9, byKind: { video: 1, text: 1 }, editableNodes: 1, animatedProperties: 2, masks: 0 },
      dominant: { asset: "broll.mp4", role: "linked", coverage: 0.85 },
      issues: [],
    };
    expect(productionIntegrity.output.safeParse({ op: "check", summary: "clean", verdict: "pass", scenes: [scene], issues: [] }).success).toBe(true);
    expect(productionIntegrity.output.safeParse({
      op: "check",
      summary: "clean",
      verdict: "pass",
      scenes: [{ ...scene, dominant: null }],
      issues: [],
    }).success).toBe(true);
    expect(productionIntegrity.output.safeParse({ op: "check", summary: "clean" }).success).toBe(true);
  });
});
