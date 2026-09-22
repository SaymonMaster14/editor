/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { getAssetFile } from "@diffusionstudio/runtime";
import {
  DapiError,
  FLOW_ENGINE_DIS,
  FLOW_ENGINE_RAFT,
  FLOW_ENGINE_VERSION_DIS,
  FLOW_ENGINE_VERSION_RAFT,
  FLOW_MAX_WIDTH,
} from "@diffusionstudio/dapi";
import { mainBridge } from "@/lib/ipc";
import { analyzeCached, mediaStore } from "../lib/analysis-cache";
import { requireAssetType, resolveAsset } from "../lib/assets";
import { decodeCappedFrame } from "../lib/capped-frame";

import type { FlowWorkerResult } from "@diffusionstudio/dapi";
import type { ToolHandler } from "../handler";

export const mediaFlow: ToolHandler<"media_flow"> = async ({ path, time, dt, engine }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  requireAssetType(asset, ["VIDEO"], "a video");
  const at = time ?? 0;
  const gap = dt ?? 1 / 30;
  const atB = at + gap;
  const duration = asset.duration;
  if (duration !== undefined && atB > duration) {
    throw new DapiError(
      "invalid-input",
      `time ${atB.toFixed(3)}s (time + dt) is past the asset's duration (${duration.toFixed(2)}s).`,
    );
  }
  const picked = engine ?? "raft";

  const blob = await getAssetFile(asset);
  const { result, cached } = await analyzeCached({
    kind: "media_flow",
    engine: picked === "raft" ? FLOW_ENGINE_RAFT : FLOW_ENGINE_DIS,
    engineVersion: picked === "raft" ? FLOW_ENGINE_VERSION_RAFT : FLOW_ENGINE_VERSION_DIS,
    source: blob,
    params: { time: at, timeB: atB, engine: picked },
    ...(duration !== undefined ? { duration } : {}),
    cache: mediaStore,
    run: async () => {
      const frameA = await decodeCappedFrame(asset.type, blob, at, FLOW_MAX_WIDTH);
      const frameB = await decodeCappedFrame(asset.type, blob, atB, FLOW_MAX_WIDTH);
      if (frameA.canvas.width !== frameB.canvas.width || frameA.canvas.height !== frameB.canvas.height) {
        throw new DapiError("unsupported", "The two decoded frames differ in size; flow needs matching frames.");
      }
      let flow: FlowWorkerResult;
      try {
        flow = await mainBridge.call(MAIN_CHANNELS.FLOW_RUN, { pngA: frameA.png, pngB: frameB.png, engine: picked });
      } catch (error) {
        throw new DapiError("unsupported", (error as Error).message);
      }
      return {
        path: asset.path,
        time: at,
        timeB: atB,
        width: frameA.canvas.width,
        height: frameA.canvas.height,
        engine: picked === "raft" ? FLOW_ENGINE_RAFT : FLOW_ENGINE_DIS,
        device: flow.device,
        ms: flow.ms,
        meanMag: flow.meanMag,
        p95Mag: flow.p95Mag,
        flow: flow.flow,
        preview: flow.preview,
      };
    },
  });
  return { ...result, cached };
};
