/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import {
  classifyAssetRole,
  dominantAsset,
  isAttributedRole,
  judgeProgram,
  judgeScene,
  unionLength,
} from "./production-integrity";

import type { IntegrityAssetRef, IntegritySceneFacts } from "./production-integrity";

function ref(overrides: Partial<IntegrityAssetRef> = {}): IntegrityAssetRef {
  return {
    id: "a1",
    path: "final.mp4",
    source: "assets/final.mp4",
    transient: false,
    hasProvenance: false,
    hasGeneration: false,
    hasEscalation: false,
    ...overrides,
  };
}

function scene(overrides: Partial<IntegritySceneFacts> = {}): IntegritySceneFacts {
  const assets = overrides.assets ?? [ref()];
  return {
    id: "scene1",
    windowFrames: 100,
    coverage: [{ assetId: "a1", spans: [{ start: 0, end: 90 }] }],
    editableNodes: 0,
    assets,
    ...overrides,
  };
}

describe("unionLength", () => {
  it("merges overlaps and sums disjoint spans", () => {
    expect(unionLength([])).toBe(0);
    expect(unionLength([{ start: 0, end: 10 }])).toBe(10);
    expect(unionLength([{ start: 0, end: 10 }, { start: 5, end: 15 }])).toBe(15);
    expect(unionLength([{ start: 0, end: 10 }, { start: 20, end: 30 }])).toBe(20);
  });

  it("ignores degenerate spans", () => {
    expect(unionLength([{ start: 5, end: 5 }, { start: 9, end: 4 }, { start: 0, end: 10 }])).toBe(10);
  });
});

describe("classifyAssetRole", () => {
  it("prefers declaration over origin: escalation, then generation, then provenance", () => {
    expect(classifyAssetRole(ref({ hasEscalation: true, hasGeneration: true, hasProvenance: true }))).toBe("escalated");
    expect(classifyAssetRole(ref({ hasGeneration: true, hasProvenance: true }))).toBe("generated");
    expect(classifyAssetRole(ref({ hasProvenance: true }))).toBe("imported");
  });

  it("reads transient bytes as transient, hotlinks as remote", () => {
    expect(classifyAssetRole(ref({ transient: true, source: "C:\\tmp\\final.mp4" }))).toBe("transient");
    expect(classifyAssetRole(ref({ transient: true, source: "https://cdn.example/final.mp4" }))).toBe("remote");
    expect(classifyAssetRole(ref({ source: "https://cdn.example/final.mp4" }))).toBe("remote");
  });

  it("reads absolute paths as linked user files on every platform form", () => {
    expect(classifyAssetRole(ref({ source: "C:\\footage\\clip.mp4" }))).toBe("linked");
    expect(classifyAssetRole(ref({ source: "C:/footage/clip.mp4" }))).toBe("linked");
    expect(classifyAssetRole(ref({ source: "\\\\server\\share\\clip.mp4" }))).toBe("linked");
    expect(classifyAssetRole(ref({ source: "/mnt/footage/clip.mp4" }))).toBe("linked");
  });

  it("reads project-relative bytes as project-local and empties as unknown", () => {
    expect(classifyAssetRole(ref({ source: "assets/final.mp4" }))).toBe("project-local");
    expect(classifyAssetRole(ref({ source: "" }))).toBe("unknown");
  });

  it("attributes declarations, generations, imports, and links only", () => {
    for (const role of ["escalated", "generated", "imported", "linked"] as const) {
      expect(isAttributedRole(role)).toBe(true);
    }
    for (const role of ["project-local", "transient", "remote", "unknown"] as const) {
      expect(isAttributedRole(role)).toBe(false);
    }
  });
});

describe("dominantAsset", () => {
  it("names the asset at or past 80% and skips the rest", () => {
    const at = dominantAsset(scene());
    expect(at?.ref.id).toBe("a1");
    expect(at?.coverage).toBeCloseTo(0.9, 5);
    expect(dominantAsset(scene({ coverage: [{ assetId: "a1", spans: [{ start: 0, end: 79 }] }] }))).toBeNull();
    expect(dominantAsset(scene({ coverage: [{ assetId: "a1", spans: [{ start: 0, end: 80 }] }] }))?.coverage).toBeCloseTo(0.8, 5);
  });

  it("merges an asset's spans before measuring and picks the largest", () => {
    const two = [ref(), ref({ id: "a2", path: "b.mp4", source: "assets/b.mp4" })];
    const facts = scene({
      assets: two,
      coverage: [
        { assetId: "a1", spans: [{ start: 0, end: 30 }, { start: 20, end: 50 }] },
        { assetId: "a2", spans: [{ start: 50, end: 100 }] },
      ],
    });
    // a1 unions to 50 frames, a2 to 50: neither dominates.
    expect(dominantAsset(facts)).toBeNull();
    expect(
      dominantAsset(scene({ assets: two, coverage: [...facts.coverage, { assetId: "a2", spans: [{ start: 10, end: 60 }] }] }))?.ref.id,
    ).toBe("a2");
  });

  it("passes empty windows and dangling asset ids", () => {
    expect(dominantAsset(scene({ windowFrames: 0 }))).toBeNull();
    expect(dominantAsset(scene({ coverage: [] }))).toBeNull();
    expect(dominantAsset(scene({ coverage: [{ assetId: "ghost", spans: [{ start: 0, end: 100 }] }] }))).toBeNull();
  });
});

describe("judgeScene", () => {
  it("errors on a dominant unattributed render with no editable structure", () => {
    for (const unattributed of [
      ref({ source: "assets/final.mp4" }),
      ref({ transient: true, source: "C:\\tmp\\final.mp4", path: "C:\\tmp\\final.mp4" }),
      ref({ transient: true, source: "https://cdn.example/final.mp4", path: "https://cdn.example/final.mp4" }),
      ref({ source: "" }),
    ]) {
      const verdict = judgeScene(scene({ assets: [unattributed] }));
      expect(verdict.issues).toHaveLength(1);
      expect(verdict.issues[0]?.code).toBe("flattened-scene");
      expect(verdict.issues[0]?.severity).toBe("error");
      expect(verdict.issues[0]?.message).toMatch(/record-escalation/);
    }
  });

  it("warns — not errors — on a lone linked file, and passes every other attributed dominant", () => {
    const linked = judgeScene(scene({ assets: [ref({ source: "C:\\footage\\clip.mp4" })] }));
    expect(linked.issues.map((issue) => issue.code)).toEqual(["linked-solo"]);
    expect(linked.issues[0]?.severity).toBe("warning");
    expect(linked.issues[0]?.message).toMatch(/scope "footage"/);

    for (const attributed of [
      ref({ hasEscalation: true }),
      ref({ hasGeneration: true }),
      ref({ hasProvenance: true }),
    ]) {
      expect(judgeScene(scene({ assets: [attributed] })).issues).toEqual([]);
    }
  });

  it("passes dominance with editable structure and non-dominance without it", () => {
    expect(judgeScene(scene({ editableNodes: 2 })).issues).toEqual([]);
    expect(judgeScene(scene({ editableNodes: 1, assets: [ref({ source: "C:\\footage\\clip.mp4" })] })).issues).toEqual([]);
    expect(judgeScene(scene({ coverage: [{ assetId: "a1", spans: [{ start: 0, end: 40 }] }] })).issues).toEqual([]);
  });
});

describe("judgeProgram", () => {
  it("fails a one-scene program that is one flattened render", () => {
    const program = judgeProgram([scene()]);
    expect(program.verdict).toBe("fail");
    expect(program.issues.map((issue) => issue.code)).toEqual(["flattened-program"]);
    expect(program.issues[0]?.severity).toBe("error");
    expect(program.scenes).toHaveLength(1);
    expect(program.scenes[0]?.issues.map((issue) => issue.code)).toEqual(["flattened-scene"]);
  });

  it("keeps the flattened-program rule to single-scene programs", () => {
    const program = judgeProgram([
      scene(),
      scene({ id: "scene2", coverage: [{ assetId: "a1", spans: [{ start: 0, end: 10 }] }] }),
    ]);
    expect(program.verdict).toBe("fail");
    expect(program.issues).toEqual([]);
    expect(program.scenes[0]?.issues.map((issue) => issue.code)).toEqual(["flattened-scene"]);
    expect(program.scenes[1]?.issues).toEqual([]);
  });

  it("passes clean and warning-only programs", () => {
    expect(judgeProgram([scene({ editableNodes: 3 })]).verdict).toBe("pass");
    const linkedSolo = judgeProgram([scene({ assets: [ref({ source: "D:\\cam\\a.mp4" })] })]);
    expect(linkedSolo.verdict).toBe("pass");
    expect(linkedSolo.scenes[0]?.issues.map((issue) => issue.code)).toEqual(["linked-solo"]);
    expect(linkedSolo.issues).toEqual([]);
  });
});
