/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { NodeId } from "../schemas";

/**
 * One op-dispatched tool for the canonical timeline edits — not one tool
 * per verb. The handler calls the same `engine/nle` + `engine/timing`
 * functions the keyboard and timeline gestures call, so UI, shortcut, MCP,
 * and agent edits converge on one implementation, one undo entry each,
 * and one source sync to the file. Frames are timeline frames of the
 * clip's own parent, at the project's frame rate.
 */
export const timelineEdit = defineTool({
  name: "timeline_edit",
  title: "Edit the timeline",
  description:
    "Run one canonical timeline edit on the open project (local, no credits): lift, extract (ripple delete), rippleTrimIn/Out/PreviousToPlayhead (Q), roll, slip, slide, move, trimIn, trimOut — plus undo, redo, and list (read back every clip's span). Targets are node ids (the id attributes in the project's JSX). Frame/delta are timeline frames at the project rate: frame is the destination for trim/move/roll/ripple ops, delta the shift for slip/slide. Multi-target lift/extract takes extra ids via targets. Reports the resulting spans so the caller can verify without re-reading the file.",
  input: z.object({
    op: z.enum([
      "lift",
      "extract",
      "rippleTrimIn",
      "rippleTrimOut",
      "rippleTrimPreviousToPlayhead",
      "roll",
      "slip",
      "slide",
      "move",
      "trimIn",
      "trimOut",
      "undo",
      "redo",
      "list",
    ]),
    target: NodeId.optional().describe("node id the op applies to; unneeded for undo/redo"),
    frame: z.int().min(0).optional().describe("destination timeline frame for trim/move/roll/ripple ops"),
    delta: z.int().optional().describe("shift in frames for slip/slide"),
    targets: z.array(NodeId).max(32).optional().describe("extra node ids for multi-target lift/extract"),
  }),
  output: z.object({
    op: z.string(),
    target: z.string().optional(),
    summary: z.string().describe("what happened, in one human sentence"),
    spans: z.record(z.string(), z.object({ start: z.number(), end: z.number() })).describe(
      "timeline spans after the edit, keyed by node id: the target plus every shifted/trimmed sibling",
    ),
    removed: z.array(z.string()).optional().describe("node ids removed by lift/extract"),
    shifted: z.array(z.string()).optional().describe("node ids that moved to close or follow the edit"),
  }),
  environment: "renderer",
});
