/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Procedural CPU effects over decoded RGB frames. A stack is plain data —
// `[{ kind: "grain", params: { amount: 12 } }, ...]` — so agents can read,
// write, and diff it; `applyEffects` evaluates the stack in order over one
// frame. Randomized effects are seeded and clocked by the frame's own
// time, so the same bytes + time + stack always render the same bytes,
// while consecutive frames of grain and shake still evolve. Effects never
// mutate their input.
//
// Honest limits: these are per-frame pixel transforms, not a compositor.
// There is no motion blur across frames, no temporal denoising, and no
// GPU path — 160-320 px-wide previews render in milliseconds on CPU,
// full-res frames cost linearly more.

import type { SceneFrame } from "@diffusionstudio/scene";

export const EFFECT_KINDS = ["grain", "vignette", "rgbSplit", "pixelate", "scanlines", "shake", "posterize"] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

/**
 * One stack entry. `kind` is a plain string (not the union) so the wire
 * format tolerates versions that know more effects; unknown kinds fail
 * with the supported list. Param values are numbers; unknown or
 * out-of-range params fail rather than silently clipping.
 */
export type EffectSpec = {
  kind: string;
  params?: Record<string, number>;
};

export type EffectedFrame = {
  data: Uint8Array;
  width: number;
  height: number;
  time: number;
};

function isEffectKind(kind: string): kind is EffectKind {
  return (EFFECT_KINDS as ReadonlyArray<string>).includes(kind);
}

function fail(kind: string, message: string): never {
  throw new Error(`effects: ${kind}: ${message}`);
}

function checkUnknown(kind: string, params: Record<string, number>, known: ReadonlyArray<string>): void {
  for (const key of Object.keys(params)) {
    if (!known.includes(key)) fail(kind, `unknown param ${JSON.stringify(key)} (known: ${known.join(", ") || "none"})`);
  }
}

function num(kind: string, params: Record<string, number>, name: string, def: number, min: number, max: number): number {
  const value = params[name] ?? def;
  if (!Number.isFinite(value)) fail(kind, `${name} must be a finite number, got ${value}`);
  if (value < min || value > max) fail(kind, `${name} must be in ${min}..${max}, got ${value}`);
  return value;
}

function int(kind: string, params: Record<string, number>, name: string, def: number, min: number, max: number): number {
  const value = num(kind, params, name, def, min, max);
  if (!Number.isInteger(value)) fail(kind, `${name} must be an integer, got ${value}`);
  return value;
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/** Deterministic 32-bit stream. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic [0, 1) from two integers. */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function validateFrame(frame: SceneFrame): void {
  if (!Number.isInteger(frame.width) || frame.width <= 0 || !Number.isInteger(frame.height) || frame.height <= 0) {
    throw new Error(`effects: need positive integer dimensions, got ${frame.width}x${frame.height}`);
  }
  if (frame.data.length !== frame.width * frame.height * 3) {
    throw new Error(`effects: need width*height*3 bytes, got ${frame.data.length} for ${frame.width}x${frame.height}`);
  }
  if (!Number.isFinite(frame.time) || frame.time < 0) {
    throw new Error(`effects: need a finite non-negative time, got ${frame.time}`);
  }
}

type Pixel = { data: Uint8Array | Uint8ClampedArray; width: number; height: number };

function applyGrain(src: Pixel, time: number, params: Record<string, number>): Uint8Array {
  const kind = "grain";
  checkUnknown(kind, params, ["amount", "seed"]);
  const amount = num(kind, params, "amount", 8, 0, 64);
  const seed = int(kind, params, "seed", 1, 0, 0xffffffff);
  const out = new Uint8Array(src.data.length);
  if (amount === 0) {
    out.set(src.data);
    return out;
  }
  // The stream is seeded per frame: identical frames at different times
  // get different grain, identical (bytes, time) pairs get identical grain.
  const rand = mulberry32((Math.imul(seed, 2654435761) ^ Math.imul(Math.round(time * 1000), 40503)) | 0);
  for (let i = 0; i < src.data.length; i++) {
    out[i] = clamp255(src.data[i]! + (rand() * 2 - 1) * amount);
  }
  return out;
}

function applyVignette(src: Pixel, params: Record<string, number>): Uint8Array {
  const kind = "vignette";
  checkUnknown(kind, params, ["strength"]);
  const strength = num(kind, params, "strength", 0.4, 0, 1);
  const out = new Uint8Array(src.data.length);
  const { width, height } = src;
  for (let y = 0; y < height; y++) {
    const ny = ((y + 0.5) / height) * 2 - 1;
    for (let x = 0; x < width; x++) {
      const nx = ((x + 0.5) / width) * 2 - 1;
      // 0 at the center, 1 at the corners: corners keep 1 - strength.
      const factor = 1 - strength * ((nx * nx + ny * ny) / 2);
      const i = (y * width + x) * 3;
      out[i] = clamp255(src.data[i]! * factor);
      out[i + 1] = clamp255(src.data[i + 1]! * factor);
      out[i + 2] = clamp255(src.data[i + 2]! * factor);
    }
  }
  return out;
}

function applyRgbSplit(src: Pixel, params: Record<string, number>): Uint8Array {
  const kind = "rgbSplit";
  checkUnknown(kind, params, ["distance"]);
  const distance = int(kind, params, "distance", 4, 0, 64);
  const out = new Uint8Array(src.data.length);
  const { data, width, height } = src;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      // Red looks left, blue looks right, green stays: out-of-frame reads
      // are black, the classic fringe.
      const rl = x - distance;
      const br = x + distance;
      out[i] = rl >= 0 ? data[(y * width + rl) * 3]! : 0;
      out[i + 1] = data[i + 1]!;
      out[i + 2] = br < width ? data[(y * width + br) * 3 + 2]! : 0;
    }
  }
  return out;
}

function applyPixelate(src: Pixel, params: Record<string, number>): Uint8Array {
  const kind = "pixelate";
  checkUnknown(kind, params, ["size"]);
  const size = int(kind, params, "size", 8, 2, 128);
  const out = new Uint8Array(src.data.length);
  const { data, width, height } = src;
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(y / size) * size;
    for (let x = 0; x < width; x++) {
      const sx = Math.floor(x / size) * size;
      const from = (sy * width + sx) * 3;
      const to = (y * width + x) * 3;
      out[to] = data[from]!;
      out[to + 1] = data[from + 1]!;
      out[to + 2] = data[from + 2]!;
    }
  }
  return out;
}

function applyScanlines(src: Pixel, params: Record<string, number>): Uint8Array {
  const kind = "scanlines";
  checkUnknown(kind, params, ["amount", "pitch"]);
  const amount = num(kind, params, "amount", 0.25, 0, 1);
  const pitch = int(kind, params, "pitch", 3, 2, 8);
  const out = new Uint8Array(src.data.length);
  const { data, width, height } = src;
  const dim = 1 - amount;
  for (let y = 0; y < height; y++) {
    const dark = y % pitch === pitch - 1;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      out[i] = dark ? clamp255(data[i]! * dim) : data[i]!;
      out[i + 1] = dark ? clamp255(data[i + 1]! * dim) : data[i + 1]!;
      out[i + 2] = dark ? clamp255(data[i + 2]! * dim) : data[i + 2]!;
    }
  }
  return out;
}

function applyShake(src: Pixel, time: number, params: Record<string, number>): Uint8Array {
  const kind = "shake";
  checkUnknown(kind, params, ["amplitude", "frequency", "seed"]);
  const amplitude = num(kind, params, "amplitude", 6, 0, 64);
  const frequency = num(kind, params, "frequency", 8, 0.5, 30);
  const seed = int(kind, params, "seed", 1, 0, 0xffffffff);
  const out = new Uint8Array(src.data.length);
  const { data, width, height } = src;
  if (amplitude === 0) {
    out.set(data);
    return out;
  }
  // Two detuned sines per axis with seed-derived phases: smooth but not
  // periodic-looking, and a pure function of time.
  const phase = (n: number): number => hash01(seed, n) * Math.PI * 2;
  const wobble = (t: number, p1: number, p2: number): number =>
    0.6 * Math.sin(Math.PI * 2 * frequency * t + p1) + 0.4 * Math.sin(Math.PI * 2 * frequency * 2.7 * t + p2);
  const dx = Math.round(amplitude * wobble(time, phase(1), phase(2)));
  const dy = Math.round(amplitude * wobble(time, phase(3), phase(4)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const sx = x - dx;
      const sy = y - dy;
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) {
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
      } else {
        const from = (sy * width + sx) * 3;
        out[i] = data[from]!;
        out[i + 1] = data[from + 1]!;
        out[i + 2] = data[from + 2]!;
      }
    }
  }
  return out;
}

function applyPosterize(src: Pixel, params: Record<string, number>): Uint8Array {
  const kind = "posterize";
  checkUnknown(kind, params, ["levels"]);
  const levels = int(kind, params, "levels", 4, 2, 16);
  const out = new Uint8Array(src.data.length);
  const step = 255 / (levels - 1);
  for (let i = 0; i < src.data.length; i++) {
    out[i] = clamp255(Math.round(src.data[i]! / step) * step);
  }
  return out;
}

/**
 * Evaluates `stack` over `frame`, first entry to last, and returns a new
 * frame — the input is never mutated. An empty stack returns an equal
 * copy. Unknown kinds, unknown params, and out-of-range values throw.
 */
export function applyEffects(frame: SceneFrame, stack: ReadonlyArray<EffectSpec>): EffectedFrame {
  validateFrame(frame);
  let current: Pixel = { data: frame.data, width: frame.width, height: frame.height };
  for (const entry of stack) {
    const params = entry.params ?? {};
    let data: Uint8Array;
    switch (entry.kind) {
      case "grain":
        data = applyGrain(current, frame.time, params);
        break;
      case "vignette":
        data = applyVignette(current, params);
        break;
      case "rgbSplit":
        data = applyRgbSplit(current, params);
        break;
      case "pixelate":
        data = applyPixelate(current, params);
        break;
      case "scanlines":
        data = applyScanlines(current, params);
        break;
      case "shake":
        data = applyShake(current, frame.time, params);
        break;
      case "posterize":
        data = applyPosterize(current, params);
        break;
      default:
        throw new Error(
          `effects: unknown kind ${JSON.stringify(entry.kind)} (supported: ${EFFECT_KINDS.join(", ")})`,
        );
    }
    current = { data, width: frame.width, height: frame.height };
  }
  const data = current.data instanceof Uint8Array ? current.data : Uint8Array.from(current.data);
  return { data: stack.length ? data : Uint8Array.from(frame.data), width: frame.width, height: frame.height, time: frame.time };
}

export { isEffectKind };
