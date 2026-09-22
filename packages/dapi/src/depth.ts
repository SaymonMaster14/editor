/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The weights the depth worker loads. Bumped with the worker protocol, not the model run. */
export const DEPTH_ENGINE = "depth-anything-v2-small";
export const DEPTH_ENGINE_VERSION = "Depth-Anything-V2-Small-hf/worker-1";

/**
 * What the main-process depth worker answers over the DEPTH_RUN channel:
 * the analyzed size, which device ran, inference milliseconds, the raw
 * relative-inverse-depth range, and the normalized 16-bit depth map.
 * Plain types, not zod — the driver validates the worker's JSON before
 * it crosses IPC.
 */
export type DepthWorkerResult = {
  width: number;
  height: number;
  device: string;
  ms: number;
  /** Raw model minimum for this frame; pixel 0 maps here. */
  dmin: number;
  /** Raw model maximum for this frame; pixel 65535 maps here. Larger = closer. */
  dmax: number;
  /** 16-bit grayscale PNG bytes at the analyzed frame's size. */
  depth: Uint8Array;
};
