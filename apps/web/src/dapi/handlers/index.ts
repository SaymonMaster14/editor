/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { open } from "./open";
import { assetsImport } from "./assets-import";
import { qaSweep } from "./qa-sweep";
import { context } from "./context";
import { capture } from "./capture";
import { check } from "./check";
import { exportScene } from "./export";
import { models } from "./models";
import { voices } from "./voices";
import { whoami } from "./whoami";
import { screenshot } from "./screenshot";
import { mediaProbe } from "./media-probe";
import { mediaEffects } from "./media-effects";
import { mediaGrab } from "./media-grab";
import { mediaTranscribe } from "./media-transcribe";
import { mediaFilmstrip } from "./media-filmstrip";
import { mediaWaveform } from "./media-waveform";
import { mediaListen } from "./media-listen";
import { mediaScenes } from "./media-scenes";
import { mediaTrack } from "./media-track";
import { mediaStabilize } from "./media-stabilize";
import { mediaReframe } from "./media-reframe";
import { mediaKey } from "./media-key";
import { mediaRetime } from "./media-retime";
import { mediaScopes } from "./media-scopes";
import { mediaSegment } from "./media-segment";
import { mediaDepth } from "./media-depth";
import { mediaFlow } from "./media-flow";
import { timelineEdit } from "./timeline-edit";
import { sourceEdit } from "./source-edit";
import { marker } from "./marker";
import { keyframe } from "./keyframe";
import { audioEdit } from "./audio-edit";
import { audioLoudness } from "./audio-loudness";
import { audioBeats } from "./audio-beats";

import type { Handlers } from "../handler";

/** Every tool the renderer answers, keyed by its catalog name. */
export const handlers: Handlers = {
  open,
  assets_import: assetsImport,
  context,
  capture,
  check,
  qa_sweep: qaSweep,
  export: exportScene,
  models,
  voices,
  whoami,
  screenshot,
  media_probe: mediaProbe,
  media_effects: mediaEffects,
  media_grab: mediaGrab,
  media_transcribe: mediaTranscribe,
  media_filmstrip: mediaFilmstrip,
  media_waveform: mediaWaveform,
  media_listen: mediaListen,
  media_scenes: mediaScenes,
  media_track: mediaTrack,
  media_stabilize: mediaStabilize,
  media_reframe: mediaReframe,
  media_key: mediaKey,
  media_retime: mediaRetime,
  media_scopes: mediaScopes,
  media_segment: mediaSegment,
  media_depth: mediaDepth,
  media_flow: mediaFlow,
  timeline_edit: timelineEdit,
  source_edit: sourceEdit,
  marker,
  keyframe,
  audio_edit: audioEdit,
  audio_loudness: audioLoudness,
  audio_beats: audioBeats,
};
