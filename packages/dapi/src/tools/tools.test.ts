/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { audioBeats } from "./audio-beats";
import { capture } from "./capture";
import { context } from "./context";
import { exportScene } from "./export";
import { logs } from "./logs";
import { mediaFilmstrip } from "./media-filmstrip";
import { mediaGrab } from "./media-grab";
import { mediaListen } from "./media-listen";
import { mediaScenes } from "./media-scenes";
import { mediaTrack } from "./media-track";
import { mediaStabilize } from "./media-stabilize";
import { mediaTranscribe } from "./media-transcribe";

/** The messages of a failed parse, keyed by the path they point at. */
function issues(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) {
  expect(result.success).toBe(false);
  return Object.fromEntries((result.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message]));
}

describe("media_grab", () => {
  const input = mediaGrab.input;

  it("parses times in every form and applies the sheet default", () => {
    const args = input.parse({ path: "/clip.mp4", times: ["45f", "1:10", -1, "-2f"] });
    expect(args.times).toEqual([1.5, 70, -1, -2 / 30]);
    expect(args.separate).toBeUndefined();
    expect(args.perSheet).toBeUndefined();
  });

  it("rejects times together with count", () => {
    expect(issues(input.safeParse({ path: "/c.mp4", times: [1], count: 3 }))).toHaveProperty("count");
  });

  it("rejects auto together with times", () => {
    expect(issues(input.safeParse({ path: "/c.mp4", times: [1], auto: true }))).toHaveProperty("times");
  });

  it("requires count or auto for a window", () => {
    expect(issues(input.safeParse({ path: "/c.mp4", start: 1 }))).toHaveProperty("start");
    expect(input.safeParse({ path: "/c.mp4", start: 1, count: 2 }).success).toBe(true);
    expect(input.safeParse({ path: "/c.mp4", end: "0:10", auto: true }).success).toBe(true);
  });

  it("requires start before end", () => {
    const found = issues(input.safeParse({ path: "/c.mp4", start: 5, end: "2", count: 2 }));
    expect(found.end).toMatch(/start \(5s\) must be less than end \(2s\)/);
  });

  it("rejects negative window bounds but not negative times", () => {
    expect(issues(input.safeParse({ path: "/c.mp4", start: -1, count: 2 }))).toHaveProperty("start");
    expect(input.safeParse({ path: "/c.mp4", times: [-1] }).success).toBe(true);
  });

  it("caps the frame count unless uncapped", () => {
    expect(issues(input.safeParse({ path: "/c.mp4", count: 101 })).count).toMatch(/100-frame cap/);
    expect(input.safeParse({ path: "/c.mp4", count: 101, uncapped: true }).success).toBe(true);
    expect(input.safeParse({ path: "/c.mp4", count: 100 }).success).toBe(true);
  });

  it("rejects perSheet for separate images", () => {
    expect(issues(input.safeParse({ path: "/c.mp4", separate: true, perSheet: 4 }))).toHaveProperty("perSheet");
    expect(issues(input.safeParse({ path: "/c.mp4", perSheet: 13 }))).toHaveProperty("perSheet");
    expect(input.safeParse({ path: "/c.mp4", perSheet: 12 }).success).toBe(true);
  });
});

describe("capture", () => {
  it("takes non-negative times in every form", () => {
    expect(capture.input.parse({ id: "intro", times: [0, "45f", "1:10"] }).times).toEqual([0, 1.5, 70]);
    expect(capture.input.safeParse({ id: "intro", times: [-1] }).success).toBe(false);
    expect(capture.input.safeParse({ id: "intro", times: ["-2f"] }).success).toBe(false);
  });

  it("shares the sheet rule with media_grab", () => {
    expect(issues(capture.input.safeParse({ id: "intro", separate: true, perSheet: 2 }))).toHaveProperty("perSheet");
  });
});

describe("media_filmstrip and media_listen", () => {
  it("apply the window rule", () => {
    expect(issues(mediaFilmstrip.input.safeParse({ path: "/c.mp4", start: 3, end: 3 }))).toHaveProperty("end");
    expect(issues(mediaListen.input.safeParse({ path: "/c.mp4", start: "0:05", end: 4 }))).toHaveProperty("end");
    expect(mediaFilmstrip.input.safeParse({ path: "/c.mp4", scale: 0 }).success).toBe(false);
  });
});

describe("logs and export", () => {
  it("validate the small things the CLI used to check by hand", () => {
    expect(logs.input.safeParse({ tail: 0 }).success).toBe(false);
    expect(logs.input.safeParse({ tail: 5, level: "warning" }).success).toBe(true);
    expect(logs.input.safeParse({ level: "verbose" }).success).toBe(false);
    expect(logs.input.safeParse({ contains: "" }).success).toBe(false);
    expect(logs.input.safeParse({ since: 1700000000000, contains: "export" }).success).toBe(true);
    expect(exportScene.input.safeParse({ id: "" }).success).toBe(false);
  });
});

describe("context", () => {
  it("reports the same shape with and without an open project", () => {
    expect(
      context.output.safeParse({ rootDir: "/p", projectDir: null, currentTime: null, fontFamilies: [], generations: [] }).success,
    ).toBe(true);
    expect(
      context.output.safeParse({
        rootDir: "/p",
        projectDir: "/p/a",
        currentTime: null,
        fontFamilies: ["Inter"],
        generations: [{ element: "index.tsx:3", name: null, state: "done", asset: "gen/a.mp4" }],
      }).success,
    ).toBe(true);
    expect(context.output.safeParse({ rootDir: "/p", projectDir: "/p/a" }).success).toBe(false);
  });
});

describe("media_transcribe", () => {
  it("presents the transcript as a file: the result carries segments, the output a path", () => {
    const segments = [{ text: "Hi", words: [{ text: "Hi", start: 0, end: 0.2 }] }];
    expect(mediaTranscribe.result!.safeParse({ segments }).success).toBe(true);
    expect(mediaTranscribe.output.safeParse({ path: "/tmp/t.json", segments: 1, words: 1 }).success).toBe(true);
    expect(mediaTranscribe.output.safeParse({ segments }).success).toBe(false);
  });
});

describe("image tools", () => {
  it("present bytes as paths: the result carries png, the output a path", () => {
    expect(capture.result!.safeParse([{ timecode: "0f", png: new Uint8Array(3) }]).success).toBe(true);
    expect(capture.output.safeParse({ images: [{ timecode: "0f", path: "/tmp/0f.png" }] }).success).toBe(true);
    expect(capture.output.safeParse({ images: [{ timecode: "0f", png: new Uint8Array(3) }] }).success).toBe(false);
  });
});

describe("audio_beats", () => {
  const input = audioBeats.input;

  it("parses a bare path with an open tempo range", () => {
    const args = input.parse({ path: "/m.mp4" });
    expect(args.minBpm).toBeUndefined();
    expect(args.maxBpm).toBeUndefined();
  });

  it("rejects an inverted or non-positive tempo range", () => {
    expect(issues(input.safeParse({ path: "/m.mp4", minBpm: 200, maxBpm: 60 })).maxBpm).toMatch(/less than maxBpm/);
    expect(issues(input.safeParse({ path: "/m.mp4", minBpm: 0 }))).toHaveProperty("minBpm");
    expect(input.safeParse({ path: "/m.mp4", minBpm: 90, maxBpm: 140 }).success).toBe(true);
  });
});

describe("media_scenes", () => {
  const input = mediaScenes.input;

  it("parses a bare path with detector defaults", () => {
    const args = input.parse({ path: "/c.mp4" });
    expect(args.threshold).toBeUndefined();
    expect(args.minShotSeconds).toBeUndefined();
  });

  it("rejects a non-positive threshold or negative shot length", () => {
    expect(issues(input.safeParse({ path: "/c.mp4", threshold: 0 }))).toHaveProperty("threshold");
    expect(issues(input.safeParse({ path: "/c.mp4", minShotSeconds: -1 }))).toHaveProperty("minShotSeconds");
    expect(input.safeParse({ path: "/c.mp4", threshold: 0.5, minShotSeconds: 0 }).success).toBe(true);
  });
});

describe("media_track", () => {
  const input = mediaTrack.input;
  const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.25 };

  it("parses a box with tracker defaults", () => {
    const args = input.parse({ path: "/c.mp4", ...box });
    expect(args.time).toBeUndefined();
    expect(args.searchRadius).toBeUndefined();
    expect(args.lostThreshold).toBeUndefined();
  });

  it("rejects boxes outside the unit frame and bad options", () => {
    expect(issues(input.safeParse({ path: "/c.mp4", ...box, x: 0.9 }))).toHaveProperty("width");
    expect(issues(input.safeParse({ path: "/c.mp4", ...box, searchRadius: 0 }))).toHaveProperty("searchRadius");
    expect(issues(input.safeParse({ path: "/c.mp4", ...box, lostThreshold: 2 }))).toHaveProperty("lostThreshold");
    expect(input.safeParse({ path: "/c.mp4", time: 1.5, ...box }).success).toBe(true);
  });
});

describe("media_stabilize", () => {
  const input = mediaStabilize.input;

  it("parses a bare path with analysis defaults", () => {
    const args = input.parse({ path: "/c.mp4" });
    expect(args.patches).toBeUndefined();
    expect(args.smoothing).toBeUndefined();
  });

  it("rejects bad analysis options", () => {
    expect(issues(input.safeParse({ path: "/c.mp4", patches: 0 }))).toHaveProperty("patches");
    expect(issues(input.safeParse({ path: "/c.mp4", patchSize: 2 }))).toHaveProperty("patchSize");
    expect(issues(input.safeParse({ path: "/c.mp4", smoothing: -1 }))).toHaveProperty("smoothing");
    expect(input.safeParse({ path: "/c.mp4", patches: 3, smoothing: 0 }).success).toBe(true);
  });
});
