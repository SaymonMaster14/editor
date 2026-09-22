/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";
import { NodeId } from "../schemas";

/**
 * One op-dispatched tool for the native-first completion gate — not one
 * tool per verb. `check` judges whether each scene is an editable native
 * composition or a flattened external render standing where one should
 * be (local analysis, no credits); `record-escalation` stores the
 * inspectable justification on an asset the check would otherwise fail.
 * A flattened scene passes only by becoming native or by carrying a
 * receipt — never by assertion.
 */
export const IntegrityIssueCode = z.enum([
  "flattened-scene",
  "linked-solo",
  "flattened-program",
]);

export const IntegrityIssue = z.object({
  code: IntegrityIssueCode,
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  node: z.string().optional().describe("the scene's node id; absent only for program-wide issues"),
  asset: z.string().optional().describe("library path (or raw src) of the dominant asset, when there is one"),
  coverage: z.number().optional().describe("share of the scene the dominant asset covers, 0-1, when there is one"),
});

/** Mirrors ExternalEscalation's scope in @diffusionstudio/assets (dapi takes no asset dependency). */
export const EscalationScope = z.enum(["element", "scene", "footage"]);

export const EscalationReceipt = z.object({
  tool: z.string().describe("the external tool that produced the bytes"),
  reason: z.string().describe("why this could not reasonably be represented natively"),
  scope: EscalationScope.describe("what the asset stands for: one element, a whole scene, or source footage"),
  missingCapability: z.string().optional().describe("the native capability that was missing, when there was one"),
  createdAt: z.string().describe("ISO timestamp of the declaration"),
});

export const productionIntegrity = defineTool({
  name: "production_integrity",
  title: "Check production integrity",
  description:
    "Judge whether the project is an editable native composition (local, no credits): check reports per-scene structure stats (native entities by kind, editable nodes, animated properties, masks, the dominant video asset and its role) plus flattened-scene / flattened-program errors and linked-solo warnings — fail means the agent is not done. record-escalation stores the justification on an externally produced asset (tool, reason, scope element/scene/footage, missing capability): a declared asset passes future checks, an undeclared flattened render never does. Check a scene by id, or the whole program when id is omitted.",
  input: z.object({
    op: z.enum(["check", "record-escalation"]),
    id: NodeId.optional().describe("scene (or node) to check; the whole program when omitted (check only)"),
    asset: z.string().optional().describe("library path or id of the asset to declare (record-escalation needs it)"),
    tool: z.string().optional().describe("external tool that produced the bytes (record-escalation needs it)"),
    reason: z.string().optional().describe("why this could not reasonably be represented natively (record-escalation needs it)"),
    scope: EscalationScope.optional().describe("what the asset stands for: element, scene, or footage (record-escalation needs it)"),
    missingCapability: z.string().optional().describe("the native capability that was missing, when there was one"),
  }),
  output: z.object({
    op: z.string(),
    summary: z.string().describe("what happened, in one human sentence"),
    verdict: z.enum(["pass", "fail"]).optional().describe("fail when any error stands (check reports this)"),
    scenes: z.array(z.object({
      id: z.string(),
      duration: z.number().describe("seconds the scene plays"),
      stats: z.object({
        nodes: z.int().describe("nodes in the scene, the scene included"),
        byKind: z.record(z.string(), z.int()),
        editableNodes: z.int().describe("visible native structure: text/shape/caption/html/group/sequence/adjustment/mask/keyframed nodes"),
        animatedProperties: z.int().describe("keyframed tracks across the scene"),
        masks: z.int().describe("mask nodes in the scene"),
      }),
      dominant: z.object({
        asset: z.string().describe("library path (or raw src) of the dominant video asset"),
        role: z.string().describe("escalated, generated, imported, linked, project-local, transient, remote, or unknown"),
        coverage: z.number().describe("share of the scene the asset covers, 0-1"),
      }).nullable().describe("the video asset covering >= 80% of the scene, if any"),
      issues: z.array(IntegrityIssue),
    })).optional().describe("one verdict per checked scene (check reports these)"),
    issues: z.array(IntegrityIssue).optional().describe("program-wide issues (check reports these)"),
    escalation: EscalationReceipt.optional().describe("the stored receipt (record-escalation reports this)"),
  }),
  environment: "renderer",
});
