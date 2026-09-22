/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";

import { applyEffects } from "./effects";

import type { SceneFrame } from "@diffusionstudio/scene";

function frame(pixels: number[], width: number, height: number, time = 0): SceneFrame {
  return { data: new Uint8Array(pixels), width, height, time };
}

function solid(value: number, width: number, height: number, time = 0): SceneFrame {
  return { data: new Uint8Array(width * height * 3).fill(value), width, height, time };
}

describe("applyEffects", () => {
  it("copies on an empty stack without aliasing the input", () => {
    const input = frame([10, 20, 30, 40, 50, 60], 2, 1);
    const out = applyEffects(input, []);
    expect([...out.data]).toEqual([10, 20, 30, 40, 50, 60]);
    expect(out.data).not.toBe(input.data);
    expect({ width: out.width, height: out.height, time: out.time }).toEqual({ width: 2, height: 1, time: 0 });
  });

  it("never mutates the input", () => {
    const input = solid(128, 8, 8);
    const before = [...input.data];
    applyEffects(input, [
      { kind: "grain", params: { amount: 20 } },
      { kind: "shake", params: { amplitude: 4 } },
      { kind: "posterize", params: { levels: 3 } },
    ]);
    expect([...input.data]).toEqual(before);
  });

  it("grain amount 0 is identity; otherwise bounded, seeded, deterministic", () => {
    const input = solid(128, 8, 8);
    expect([...applyEffects(input, [{ kind: "grain", params: { amount: 0 } }]).data]).toEqual([...input.data]);
    const a = applyEffects(input, [{ kind: "grain", params: { amount: 20, seed: 7 } }]);
    const b = applyEffects(input, [{ kind: "grain", params: { amount: 20, seed: 7 } }]);
    expect([...a.data]).toEqual([...b.data]);
    for (let i = 0; i < a.data.length; i++) expect(Math.abs(a.data[i]! - 128)).toBeLessThanOrEqual(20);
    expect([...a.data].some((v) => v !== 128)).toBe(true);
    const other = applyEffects(input, [{ kind: "grain", params: { amount: 20, seed: 8 } }]);
    expect([...other.data]).not.toEqual([...a.data]);
  });

  it("grain evolves with frame time", () => {
    const at0 = applyEffects(solid(128, 8, 8, 0), [{ kind: "grain", params: { amount: 20 } }]);
    const at1 = applyEffects(solid(128, 8, 8, 1), [{ kind: "grain", params: { amount: 20 } }]);
    expect([...at1.data]).not.toEqual([...at0.data]);
  });

  it("vignette keeps the center and darkens toward the corners", () => {
    // 2x2, strength 1: every pixel sits at d² = 0.25, factor 0.75.
    const out = applyEffects(solid(200, 2, 2), [{ kind: "vignette", params: { strength: 1 } }]);
    expect([...out.data]).toEqual(new Array(12).fill(150));
    const flat = applyEffects(solid(200, 4, 4), [{ kind: "vignette", params: { strength: 0 } }]);
    expect([...flat.data]).toEqual([...solid(200, 4, 4).data]);
    // Center brighter than the corner on a larger frame.
    const big = applyEffects(solid(200, 16, 16), [{ kind: "vignette", params: { strength: 1 } }]);
    const center = big.data[(8 * 16 + 8) * 3]!;
    const corner = big.data[0]!;
    expect(center).toBeGreaterThan(corner);
    expect(center).toBeLessThanOrEqual(200);
  });

  it("rgbSplit shifts red left and blue right with a black fringe", () => {
    // 3x1: red | green | blue.
    const input = frame([255, 0, 0, 0, 255, 0, 0, 0, 255], 3, 1);
    const out = applyEffects(input, [{ kind: "rgbSplit", params: { distance: 1 } }]);
    expect([...out.data]).toEqual([
      0, 0, 0, // red looks left off-frame, blue reads the green pixel's blue (0)
      255, 255, 255, // red reads pixel 0, green stays, blue reads pixel 2
      0, 0, 0, // red reads the green pixel's red (0), blue looks right off-frame
    ]);
  });

  it("pixelate fills each block from its top-left source pixel", () => {
    // 4x4 quadrants: R TL, G TR, B BL, W BR.
    const px: number[] = [];
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        px.push(x < 2 ? (y < 2 ? 255 : 0) : y < 2 ? 0 : 255);
        px.push(x < 2 ? 0 : y < 2 ? 255 : 255);
        px.push(x < 2 ? (y < 2 ? 0 : 255) : y < 2 ? 0 : 255);
      }
    }
    // Punch a hole: one dim pixel inside the red block must still read red.
    px[(1 * 4 + 1) * 3] = 10;
    const out = applyEffects(frame(px, 4, 4), [{ kind: "pixelate", params: { size: 2 } }]);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 3;
        const want = x < 2 ? (y < 2 ? [255, 0, 0] : [0, 0, 255]) : y < 2 ? [0, 255, 0] : [255, 255, 255];
        expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual(want);
      }
    }
  });

  it("scanlines darken every pitch-th row only", () => {
    const out = applyEffects(solid(200, 4, 5), [{ kind: "scanlines", params: { amount: 1, pitch: 2 } }]);
    for (let y = 0; y < 5; y++) {
      const want = y % 2 === 1 ? 0 : 200;
      for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 3;
        expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([want, want, want]);
      }
    }
  });

  it("shake amplitude 0 is identity; otherwise deterministic per time", () => {
    // Gradient so any shift shows.
    const px: number[] = [];
    for (let i = 0; i < 64; i++) px.push((i * 4) % 256, (i * 4) % 256, (i * 4) % 256);
    const input = frame(px, 8, 8);
    const still = applyEffects(input, [{ kind: "shake", params: { amplitude: 0 } }]);
    expect([...still.data]).toEqual(px);
    const spec = { kind: "shake", params: { amplitude: 6, frequency: 4, seed: 3 } };
    const a = applyEffects(frame(px, 8, 8, 0.5), [spec]);
    const b = applyEffects(frame(px, 8, 8, 0.5), [spec]);
    expect([...a.data]).toEqual([...b.data]);
    // The offset visibly moves across a second of footage.
    const variants = new Set<string>();
    for (let t = 0; t <= 1; t += 0.05) variants.add([...applyEffects(frame(px, 8, 8, t), [spec]).data].join(","));
    expect(variants.size).toBeGreaterThan(2);
  });

  it("posterize quantizes to exact levels", () => {
    const out = applyEffects(frame([0, 64, 128, 192, 255, 100], 2, 1), [{ kind: "posterize", params: { levels: 2 } }]);
    expect([...out.data]).toEqual([0, 0, 255, 255, 255, 0]);
    // levels 4: step 85, boundaries at 42.5 / 127.5 / 212.5.
    const four = applyEffects(frame([0, 42, 43, 84, 85, 86, 170, 212, 213], 3, 1), [
      { kind: "posterize", params: { levels: 4 } },
    ]);
    expect([...four.data]).toEqual([0, 0, 85, 85, 85, 85, 170, 170, 255]);
  });

  it("stacks apply in order and order matters", () => {
    const input = solid(200, 2, 2);
    const forward = applyEffects(input, [
      { kind: "pixelate", params: { size: 2 } },
      { kind: "scanlines", params: { amount: 1, pitch: 2 } },
    ]);
    // Pixelate first: everything reads (0,0) = 200; scanlines zero row 1.
    expect([...forward.data]).toEqual([200, 200, 200, 200, 200, 200, 0, 0, 0, 0, 0, 0]);
    const reversed = applyEffects(input, [
      { kind: "scanlines", params: { amount: 1, pitch: 2 } },
      { kind: "pixelate", params: { size: 2 } },
    ]);
    // Scanlines first zero row 1, then pixelate re-reads (0,0) = 200 everywhere.
    expect([...reversed.data]).toEqual(new Array(12).fill(200));
  });

  it("rejects unknown kinds, params, ranges, and malformed frames", () => {
    const input = solid(10, 2, 2);
    expect(() => applyEffects(input, [{ kind: "bloom" }])).toThrow(/unknown kind "bloom".*grain/);
    expect(() => applyEffects(input, [{ kind: "grain", params: { amout: 3 } }])).toThrow(/unknown param "amout"/);
    expect(() => applyEffects(input, [{ kind: "grain", params: { amount: 65 } }])).toThrow(/0\.\.64/);
    expect(() => applyEffects(input, [{ kind: "pixelate", params: { size: 2.5 } }])).toThrow(/integer/);
    expect(() => applyEffects(input, [{ kind: "scanlines", params: { pitch: 9 } }])).toThrow(/2\.\.8/);
    expect(() => applyEffects({ data: new Uint8Array(11), width: 2, height: 2, time: 0 }, [])).toThrow(/width\*height\*3/);
    expect(() => applyEffects({ data: new Uint8Array(12), width: 0, height: 2, time: 0 }, [])).toThrow(/dimensions/);
    expect(() => applyEffects(solid(10, 2, 2, Number.NaN), [])).toThrow(/time/);
  });
});
