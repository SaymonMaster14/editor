/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import { getAssetFile } from "@diffusionstudio/runtime";
import { trackBeats } from "@diffusionstudio/audio";
import { DapiError } from "@diffusionstudio/dapi";
import { analyzeCached } from "../lib/analysis-cache";
import { resolveAsset } from "../lib/assets";

import type { ToolHandler } from "../handler";

/** Beat tracking holds whole-file mono PCM: refuse past 30 minutes (~345 MB at 48 kHz). */
const MAX_BEATS_SECONDS = 30 * 60;

export const audioBeats: ToolHandler<"audio_beats"> = async ({ path, minBpm, maxBpm }, ctx) => {
  const asset = await resolveAsset(ctx, path);
  const blob = await getAssetFile(asset);

  const { result, cached } = await analyzeCached({
    kind: "audio_beats",
    engine: "diffusion-audio",
    engineVersion: "1",
    source: blob,
    params: { minBpm, maxBpm },
    ...("duration" in asset ? { duration: asset.duration } : {}),
    run: async () => {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) {
          throw new DapiError("wrong-kind", `Asset ${asset.id} has no audio track to track beats on.`);
        }

        const sampleRate = track.sampleRate;
        const channels = track.numberOfChannels;
        // Mono accumulation, chunked: beats need whole-file context, but
        // samples arrive in small planes — grow one buffer per chunk.
        const chunks: Float32Array[] = [];
        let fed = 0;

        const pushMono = (planes: Float32Array[], frames: number): void => {
          const mono = new Float32Array(frames);
          for (let c = 0; c < channels; c++) {
            const plane = planes[c]!;
            for (let i = 0; i < frames; i++) mono[i]! += plane[i]!;
          }
          const gain = 1 / channels;
          for (let i = 0; i < frames; i++) mono[i]! *= gain;
          chunks.push(mono);
          fed += frames;
        };

        const sink = new AudioSampleSink(track);
        for await (const sample of sink.samples()) {
          try {
            const expected = Math.round(sample.timestamp * sampleRate);
            let gap = expected - fed;
            while (gap > 0) {
              const frames = Math.min(gap, sampleRate);
              chunks.push(new Float32Array(frames));
              fed += frames;
              gap -= frames;
              if (fed > MAX_BEATS_SECONDS * sampleRate) {
                throw new DapiError("invalid-input", `Beat tracking refuses files past 30 minutes; got ${Math.round(fed / sampleRate)} s of audio.`);
              }
            }

            const frames = sample.numberOfFrames;
            const planeBytes = sample.allocationSize({ planeIndex: 0, format: "f32-planar" });
            const planes: Float32Array[] = [];
            for (let c = 0; c < channels; c++) {
              const plane = new Float32Array(planeBytes / Float32Array.BYTES_PER_ELEMENT);
              sample.copyTo(plane, { planeIndex: c, format: "f32-planar" });
              planes.push(plane);
            }
            pushMono(planes, frames);
          } finally {
            sample.close();
          }
        }

        const mono = new Float32Array(fed);
        let at = 0;
        for (const chunk of chunks) {
          mono.set(chunk, at);
          at += chunk.length;
        }
        const grid = trackBeats([mono], sampleRate, {
          ...(minBpm !== undefined ? { minBpm } : {}),
          ...(maxBpm !== undefined ? { maxBpm } : {}),
        });
        return {
          path: asset.path,
          sampleRate,
          channels,
          bpm: grid.bpm === 0 ? null : grid.bpm,
          beats: grid.beats,
          onsets: grid.onsets,
          confidence: grid.confidence,
          seconds: grid.durationSeconds,
        };
      } finally {
        input.dispose();
      }
    },
  });
  return { ...result, cached };
};
