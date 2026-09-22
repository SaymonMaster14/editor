/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import { getAssetFile } from "@diffusionstudio/runtime";
import { LoudnessMeter } from "@diffusionstudio/audio";
import { DapiError, finiteDb } from "@diffusionstudio/dapi";
import { analyzeCached } from "../lib/analysis-cache";
import { resolveAsset } from "../lib/assets";

import type { ToolHandler } from "../handler";

export const audioLoudness: ToolHandler<"audio_loudness"> = async ({ path, targetLUFS }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  const blob = await getAssetFile(asset);

  // Only the measurement is cached: `targetLUFS` is post-arithmetic on
  // the measured value, so every target shares one slot per source.
  const { result, cached } = await analyzeCached({
    kind: "audio_loudness",
    engine: "diffusion-audio",
    engineVersion: "1",
    source: blob,
    params: {},
    ...("duration" in asset ? { duration: asset.duration } : {}),
    run: async () => {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) {
          throw new DapiError("wrong-kind", `Asset ${asset.id} has no audio track to measure.`);
        }

        const sampleRate = track.sampleRate;
        const channels = track.numberOfChannels;
        const meter = new LoudnessMeter(sampleRate, channels);
        // Gap silence, one reusable second per channel: sparse tracks read their
        // gaps as silence rather than splicing the sound together.
        const silence = Array.from({ length: channels }, () => new Float32Array(sampleRate));
        let fed = 0;

        const sink = new AudioSampleSink(track);
        for await (const sample of sink.samples()) {
          try {
            const expected = Math.round(sample.timestamp * sampleRate);
            let gap = expected - fed;
            while (gap > 0) {
              const frames = Math.min(gap, sampleRate);
              meter.push(silence, 0, frames);
              fed += frames;
              gap -= frames;
            }

            const frames = sample.numberOfFrames;
            const planeBytes = sample.allocationSize({ planeIndex: 0, format: "f32-planar" });
            const planes: Float32Array[] = [];
            for (let c = 0; c < channels; c++) {
              const plane = new Float32Array(planeBytes / Float32Array.BYTES_PER_ELEMENT);
              sample.copyTo(plane, { planeIndex: c, format: "f32-planar" });
              planes.push(plane);
            }
            meter.push(planes, 0, frames);
            fed += frames;
          } finally {
            sample.close();
          }
        }

        const measured = meter.result();
        return {
          path: asset.path,
          sampleRate,
          channels,
          integratedLUFS: finiteDb(measured.integratedLUFS),
          loudnessRangeLU: measured.loudnessRangeLU,
          truePeakDbTP: finiteDb(measured.truePeakDbTP),
          samplePeakDbFS: finiteDb(measured.samplePeakDbFS),
          seconds: measured.seconds,
        };
      } finally {
        input.dispose();
      }
    },
  });
  const integrated = typeof result.integratedLUFS === "number" ? result.integratedLUFS : null;
  return {
    ...result,
    cached,
    ...(targetLUFS !== undefined ? { targetLUFS } : {}),
    suggestedGainDb: targetLUFS !== undefined && integrated !== null ? targetLUFS - integrated : null,
  };
};
