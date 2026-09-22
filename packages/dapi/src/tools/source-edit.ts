/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { NonNegativeTime } from "../time";
import { NodeId } from "../schemas";

/**
 * One op-dispatched tool for the canonical source edits — not one tool
 * per verb. The handler calls the same `engine/source-edit` functions the
 * source monitor and the I/O and insert/overwrite shortcuts call, so UI,
 * shortcut, MCP, and agent edits converge on one implementation, one undo
 * entry each, and one source sync to the file. Source positions are times
 * in the asset's own seconds; the landing frame is a timeline frame of the
 * destination's parent, at the project's frame rate.
 */
export const sourceEdit = defineTool({
  name: "source_edit",
  title: "Edit from source",
  description:
    "Run one canonical source edit on the open project (local, no credits): load an asset into the source monitor, markIn/markOut/scrub its range, insert (land the range and shift later clips aside), overwrite (land the range where covered siblings give way), or range (read back the monitor). The monitor's range is the same range the human's I/O keys mark, so agent and human source edits meet in the middle. Asset is a library id or path. Reports the monitor range and the landed span so the caller can verify without re-reading the file.",
  input: z.object({
    op: z.enum([
      "load",
      "markIn",
      "markOut",
      "scrub",
      "insert",
      "overwrite",
      "range",
    ]),
    asset: z.string().min(1).optional().describe("library asset id or path; load needs it, insert/overwrite default to the monitor's"),
    at: NonNegativeTime.optional().describe("source position for markIn/markOut/scrub (defaults to the monitor's preview point)"),
    in: NonNegativeTime.optional().describe("explicit range in point for insert/overwrite, in source seconds (defaults to the monitor's)"),
    out: NonNegativeTime.optional().describe("explicit range out point for insert/overwrite, in source seconds (defaults to the monitor's)"),
    frame: z.int().min(0).optional().describe("landing timeline frame for insert/overwrite (defaults to the playhead)"),
    parent: NodeId.optional().describe("node id to land under for insert/overwrite (defaults to the active scene)"),
  }),
  output: z.object({
    op: z.string(),
    summary: z.string().describe("what happened, in one human sentence"),
    range: z.object({ assetId: z.string(), in: z.number(), out: z.number() }).optional().describe(
      "the monitor's marked range in source seconds, when one is loaded",
    ),
    placed: z.string().optional().describe("node id of the clip insert/overwrite landed, settled (safe to target in the next call)"),
    span: z.object({ start: z.number(), end: z.number() }).optional().describe(
      "timeline span of the landed clip",
    ),
  }),
  environment: "renderer",
});
