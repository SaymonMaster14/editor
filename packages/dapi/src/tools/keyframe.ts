/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { NodeId } from "../schemas";

/**
 * One op-dispatched tool for the canonical keyframe corrections — not one
 * tool per verb. The handler calls the same `engine/keyframes` functions the
 * timeline diamonds, the inspector's keyframe panel and the Delete key call,
 * so UI, shortcut, MCP, and agent edits converge on one implementation, one
 * undo entry each, and one source sync to the file. Frames count in the
 * clip's own time (its first frame is 0), which is what makes keyframes
 * travel with their clip; the handler reports scene frames alongside so the
 * caller can place them on the timeline.
 */
export const keyframe = defineTool({
  name: "keyframe",
  title: "Edit keyframes",
  description:
    "Run one canonical keyframe op on the open project (local, no credits): add (keyframe the property at the playhead, holding the shown value unless value is given), remove, move, set (change the held value), or list. The target is a node id (the id attributes in the project's JSX) and the property is the JSX prop name (x, y, scaleX, scaleY, rotation, opacity, volume, ...). Frames count in the clip's own time starting at 0. Reports the track's keyframes so the caller can verify without re-reading the file.",
  input: z.object({
    op: z.enum([
      "add",
      "remove",
      "move",
      "set",
      "list",
    ]),
    target: NodeId.describe("node id whose property the op applies to"),
    property: z.string().min(1).describe("JSX prop name driving the track (x, y, opacity, volume, ...)"),
    frame: z.int().min(0).optional().describe("clip-local frame for remove/move-from/set (defaults to the playhead's frame in the clip)"),
    to: z.int().min(0).optional().describe("destination clip-local frame (move needs it)"),
    value: z.union([z.number(), z.string()]).optional().describe("held value for add/set (numbers; CSS hex on a color track)"),
  }),
  output: z.object({
    op: z.string(),
    summary: z.string().describe("what happened, in one human sentence"),
    keyframe: z.object({ frame: z.number(), seconds: z.number(), value: z.union([z.number(), z.string()]), easing: z.string() }).optional().describe(
      "the keyframe the op acted on, in clip-local frames and seconds",
    ),
    keyframes: z.array(z.object({ frame: z.number(), seconds: z.number(), value: z.union([z.number(), z.string()]), easing: z.string() })).optional().describe(
      "the track's keyframes in clip-local frames and seconds, earliest first (list reports these)",
    ),
  }),
  environment: "renderer",
});
