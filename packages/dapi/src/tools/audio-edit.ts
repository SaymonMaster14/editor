/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { NodeId } from "../schemas";

/**
 * One op-dispatched tool for the canonical audio corrections — not one tool
 * per verb. The handler calls the same `engine/audio` functions the
 * inspector's audio panel calls, so UI, MCP, and agent edits converge on one
 * implementation, one undo entry each, and one source sync to the file. Gain
 * is decibels (0 is unity), fades are seconds of linear ramp, pan runs -1
 * (hard left) to 1 (hard right); each is unset at its default.
 */
export const audioEdit = defineTool({
  name: "audio_edit",
  title: "Edit clip audio",
  description:
    "Run one canonical audio correction on the open project (local, no credits): set (write any subset of gain, fades, pan, mute on a node) or get (read them back). The target is a node id (the id attributes in the project's JSX). Gain is dB with 0 at unity, fadeIn/fadeOut are seconds, pan is -1 to 1. Reports the node's audio state so the caller can verify without re-reading the file.",
  input: z.object({
    op: z.enum([
      "set",
      "get",
    ]),
    target: NodeId.describe("node id to correct (a clip with audio)"),
    gain: z.number().optional().describe("gain in dB for set (0 is unity)"),
    fadeIn: z.number().optional().describe("head fade in seconds for set (0 clears it)"),
    fadeOut: z.number().optional().describe("tail fade in seconds for set (0 clears it)"),
    pan: z.number().optional().describe("stereo position for set, -1 (left) to 1 (right)"),
    muted: z.boolean().optional().describe("mute switch for set"),
  }),
  output: z.object({
    op: z.string(),
    summary: z.string().describe("what happened, in one human sentence"),
    audio: z.object({ gain: z.number(), fadeIn: z.number(), fadeOut: z.number(), pan: z.number(), muted: z.boolean() }).describe(
      "the node's audio state after the op: gain in dB, fades in seconds, pan -1 to 1, mute switch",
    ),
  }),
  environment: "renderer",
});
