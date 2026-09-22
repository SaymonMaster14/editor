/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The engines the flow worker runs. Bumped with the worker protocol, not the model run. */
export const FLOW_ENGINE_RAFT = "raft-small";
export const FLOW_ENGINE_DIS = "dis-medium";
export const FLOW_ENGINE_VERSION_RAFT = "raft-small-torchvision/worker-1";
export const FLOW_ENGINE_VERSION_DIS = "dis-medium-opencv/worker-1";

/**
 * What the main-process flow worker answers over the FLOW_RUN channel:
 * the analyzed size, which engine and device ran, inference milliseconds,
 * motion-magnitude summaries, the full-precision flow field, and its
 * Middlebury visualization. Plain types, not zod — the driver validates
 * the worker's JSON before it crosses IPC.
 */
export type FlowWorkerResult = {
  width: number;
  height: number;
  device: string;
  engine: "dis" | "raft";
  ms: number;
  /** Mean flow magnitude over the frame, px. Near zero means a static shot. */
  meanMag: number;
  /** 95th-percentile magnitude, px: how far the fastest 5% of pixels move. */
  p95Mag: number;
  /** .npy float32 HxWx2 field: out[y, x] = (dx, dy) in analyzed-frame px. */
  flow: Uint8Array;
  /** Middlebury color-wheel PNG preview at the analyzed frame's size. */
  preview: Uint8Array;
};
