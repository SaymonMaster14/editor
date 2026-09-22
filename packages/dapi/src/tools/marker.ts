/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { NonNegativeTime } from "../time";

/**
 * One op-dispatched tool for the canonical marker edits — not one tool
 * per verb. The handler calls the same `engine/markers` functions the ruler
 * flags, the M shortcuts, the inspector panel and the timeline menu call, so
 * UI, shortcut, MCP, and agent edits converge on one implementation, one
 * undo entry each, and one source sync to the file. Positions are scene
 * times in any time form; one marker per frame, so adding where one stands
 * updates it.
 */
export const marker = defineTool({
  name: "marker",
  title: "Edit markers",
  description:
    "Run one canonical marker op on the open project (local, no credits): add (pin a flag, updating the one standing there), remove, move, list, seek (jump the playhead to the next/previous flag), or clear. The flags are the same flags the human's M key pins on the ruler, so agent and human markers meet in the middle. Reports the flags in scene frames and seconds so the caller can verify without re-reading the file.",
  input: z.object({
    op: z.enum([
      "add",
      "remove",
      "move",
      "list",
      "seek",
      "clear",
    ]),
    at: NonNegativeTime.optional().describe("position for add (defaults to the playhead) and remove (defaults to the playhead)"),
    from: NonNegativeTime.optional().describe("position of the flag to move (move needs it)"),
    to: NonNegativeTime.optional().describe("position to move the flag to (move needs it)"),
    name: z.string().optional().describe("flag label for add (keeps the standing name when omitted)"),
    color: z.string().optional().describe("flag color for add: yellow, blue, green, pink, purple, orange, cyan, or red (keeps the standing color when omitted)"),
    direction: z.enum(["next", "prev"]).optional().describe("which flag to jump to for seek (seek needs it)"),
  }),
  output: z.object({
    op: z.string(),
    summary: z.string().describe("what happened, in one human sentence"),
    marker: z.object({ at: z.number(), seconds: z.number(), name: z.string(), color: z.string() }).optional().describe(
      "the flag the op acted on, in scene frames and seconds",
    ),
    markers: z.array(z.object({ at: z.number(), seconds: z.number(), name: z.string(), color: z.string() })).optional().describe(
      "the scene's flags in scene frames and seconds, earliest first (list reports these)",
    ),
  }),
  environment: "renderer",
});
