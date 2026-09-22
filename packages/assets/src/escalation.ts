/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// External-render escalation: the inspectable justification for bytes
// Diffusion did not produce. Stored on the asset with it, so the manifest
// round-trips it with no changes (like provenance) and production
// integrity can tell a declared external element from a flattened cheat:
// the same MP4 with no receipt, no provenance, and no generation record,
// standing alone where a composition should be.

/** What the external bytes stand for in the project. */
export type EscalationScope =
  /** One element among native ones: a simulation, a 3D render, a processed plate. */
  | 'element'
  /** A whole scene's visuals, where Diffusion genuinely cannot represent them. */
  | 'scene'
  /** Source footage: shot, stocked, or generated as footage — not a flattened composition. */
  | 'footage';

/** Why an asset's bytes came from outside Diffusion. Unknown stays unknown — never guessed. */
export interface ExternalEscalation {
  /** The external tool that produced the bytes (`blender`, `hyperframes`, `camera`, …). */
  tool: string;
  /** Why this could not reasonably be represented natively — or why the footage is legitimately external. */
  reason: string;
  /** What the asset stands for: one element, a whole scene, or source footage. */
  scope: EscalationScope;
  /** The native capability that was missing, when a render escalated for lack of one. */
  missingCapability?: string;
  /** ISO timestamp of the declaration. */
  createdAt: string;
}

/** Build an escalation receipt; the caller fills what it knows, the timestamp defaults to now. */
export function escalationFor(
  receipt: { tool: string; reason: string; scope: EscalationScope; missingCapability?: string; createdAt?: Date },
): ExternalEscalation {
  return {
    tool: receipt.tool,
    reason: receipt.reason,
    scope: receipt.scope,
    ...(receipt.missingCapability === undefined ? {} : { missingCapability: receipt.missingCapability }),
    createdAt: (receipt.createdAt ?? new Date()).toISOString(),
  };
}

/** One-line justification for a declared asset, for display and receipts. */
export function escalationSummary(escalation: ExternalEscalation): string {
  return `${escalation.tool} (${escalation.scope}): ${escalation.reason}`;
}
