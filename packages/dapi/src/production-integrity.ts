/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The pure core of production integrity: asset roles, video dominance,
// and the flattened-composition verdict. No world, no fs — the renderer
// handler walks the scenes and feeds per-scene facts, so everything here
// runs under plain node tests.
//
// The question is never "is there a video" but "is the video the whole
// composition": one unattributed render covering the scene with zero
// editable native structure is a flattened cheat; the same bytes with an
// escalation receipt, provenance, a generation record, or a user's own
// linked file next to real structure are legitimate footage or elements.

/** A video asset covering at least this share of the played window dominates the scene. */
export const DOMINANCE_THRESHOLD = 0.8;

/** Absolute frames, [start, end) — the same clock the check handler walks. */
export type IntegrityInterval = { start: number; end: number };

/** What an asset's bytes are, for the verdict. Order is the classification precedence. */
export type IntegrityAssetRole =
  /** Declared legitimate: the receipt says why (element, scene, or footage). */
  | "escalated"
  /** Bytes Diffusion itself generated. */
  | "generated"
  /** Imported with provenance: provider, URL, or recorded source. */
  | "imported"
  /** A file left where the user had it (absolute path outside the project). */
  | "linked"
  /** Bytes inside the project with no attribution of any kind. */
  | "project-local"
  /** A `src` used without a library import; lives in memory only. */
  | "transient"
  /** A hotlinked URL used without an import. */
  | "remote"
  /** The asset behind the clip could not be resolved at all. */
  | "unknown";

/** The attribution facts the handler reads off one library asset. */
export type IntegrityAssetRef = {
  id: string;
  /** Library path, or the raw `src` for transient bytes. */
  path: string;
  /** The asset's `source`: absolute path, URL, or project-relative `assets/…`. Empty when unresolvable. */
  source: string;
  transient: boolean;
  hasProvenance: boolean;
  hasGeneration: boolean;
  hasEscalation: boolean;
};

function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

function isAbsolutePath(source: string): boolean {
  return source.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(source) || source.startsWith("\\\\");
}

export function classifyAssetRole(ref: IntegrityAssetRef): IntegrityAssetRole {
  if (ref.hasEscalation) return "escalated";
  if (ref.hasGeneration) return "generated";
  if (ref.hasProvenance) return "imported";
  if (ref.transient) return isHttpUrl(ref.source) ? "remote" : "transient";
  if (!ref.source) return "unknown";
  if (isHttpUrl(ref.source)) return "remote";
  if (isAbsolutePath(ref.source)) return "linked";
  return "project-local";
}

/** Roles that answer "where did these bytes come from" on their own. */
export function isAttributedRole(role: IntegrityAssetRole): boolean {
  return role === "escalated" || role === "generated" || role === "imported" || role === "linked";
}

/** One scene's facts as the handler gathers them. Coverage is video only:
 *  only `video` entities feed it, so a still-image scene never dominates. */
export type IntegritySceneFacts = {
  /** The scene's node id (its JSX id), for targeting follow-ups. */
  id: string;
  /** Frames the scene plays (its workarea-aware window); <= 0 means nothing plays. */
  windowFrames: number;
  /** Visible video spans per asset id, absolute frames. */
  coverage: { assetId: string; spans: IntegrityInterval[] }[];
  /** Visible native structure: text/shape/caption/html/group/sequence/
   *  adjustment/mask nodes plus keyframed ones. Media leaves don't count. */
  editableNodes: number;
  /** Every asset the coverage names. */
  assets: IntegrityAssetRef[];
};

/** Frames covered by at least one span. */
export function unionLength(spans: IntegrityInterval[]): number {
  const sorted = [...spans]
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -Infinity;
  for (const span of sorted) {
    const start = Math.max(span.start, cursor);
    if (span.end > start) total += span.end - start;
    cursor = Math.max(cursor, span.end);
  }
  return total;
}

export type DominantAsset = {
  ref: IntegrityAssetRef;
  role: IntegrityAssetRole;
  /** Share of the played window the asset covers, 0-1. */
  coverage: number;
};

/** The asset covering at least DOMINANCE_THRESHOLD of the played window, if any. */
export function dominantAsset(facts: IntegritySceneFacts): DominantAsset | null {
  if (facts.windowFrames <= 0) return null;
  const byId = new Map(facts.assets.map((asset) => [asset.id, asset]));
  const spansByAsset = new Map<string, IntegrityInterval[]>();
  for (const entry of facts.coverage) {
    const spans = spansByAsset.get(entry.assetId) ?? [];
    spans.push(...entry.spans);
    spansByAsset.set(entry.assetId, spans);
  }
  let best: DominantAsset | null = null;
  for (const [assetId, spans] of spansByAsset) {
    const ref = byId.get(assetId);
    if (!ref) continue;
    const coverage = unionLength(spans) / facts.windowFrames;
    if (coverage >= DOMINANCE_THRESHOLD && (!best || coverage > best.coverage)) {
      best = { ref, role: classifyAssetRole(ref), coverage };
    }
  }
  return best;
}

export type IntegrityIssueCode = "flattened-scene" | "linked-solo" | "flattened-program";

export type IntegrityIssue = {
  code: IntegrityIssueCode;
  severity: "error" | "warning";
  message: string;
  /** The scene's node id; absent only for program-wide issues. */
  node?: string;
  /** Library path (or raw `src`) of the dominant asset, when there is one. */
  asset?: string;
  /** Share of the scene the dominant asset covers, 0-1, when there is one. */
  coverage?: number;
};

export type SceneVerdict = {
  sceneId: string;
  dominant: DominantAsset | null;
  issues: IntegrityIssue[];
};

/** One scene's verdict: dominance alone is never an issue — dominance by
 *  unattributed bytes with zero editable structure is. A linked file
 *  standing alone warns (declare it as footage); anything less
 *  attributable errors (rebuild natively or record an escalation). */
export function judgeScene(facts: IntegritySceneFacts): SceneVerdict {
  const dominant = dominantAsset(facts);
  const issues: IntegrityIssue[] = [];
  if (dominant && facts.editableNodes <= 0) {
    const pct = Math.round(dominant.coverage * 100);
    if (isAttributedRole(dominant.role)) {
      if (dominant.role === "linked") {
        issues.push({
          code: "linked-solo",
          severity: "warning",
          message: `${pct}% of the scene is one linked file (${dominant.ref.path}) standing alone with no editable native structure. If it is source footage, declare it with the production_integrity record-escalation op (scope "footage") so the next check passes silently.`,
          node: facts.id,
          asset: dominant.ref.path,
          coverage: dominant.coverage,
        });
      }
    } else {
      issues.push({
        code: "flattened-scene",
        severity: "error",
        message: `${pct}% of the scene is one unattributed video (${dominant.ref.path}, ${dominant.role}) with no editable native structure — a flattened render, not a composition. Rebuild it from native Diffusion entities, or record why it is legitimate with the production_integrity record-escalation op.`,
        node: facts.id,
        asset: dominant.ref.path,
        coverage: dominant.coverage,
      });
    }
  }
  return { sceneId: facts.id, dominant, issues };
}

export type ProgramVerdict = {
  scenes: SceneVerdict[];
  /** Program-wide issues (flattened-program); scene issues live on their scene. */
  issues: IntegrityIssue[];
  /** `fail` when any error stands, scene or program level. */
  verdict: "pass" | "fail";
};

/** The program's verdict: every scene judged, plus the whole-program rule —
 *  a program that is one flattened scene is a flattened program. */
export function judgeProgram(scenes: IntegritySceneFacts[]): ProgramVerdict {
  const judged = scenes.map(judgeScene);
  const issues: IntegrityIssue[] = [];
  if (judged.length === 1 && judged[0]!.issues.some((issue) => issue.code === "flattened-scene")) {
    issues.push({
      code: "flattened-program",
      severity: "error",
      message: `The program is a single flattened scene (${judged[0]!.sceneId}): the whole video is one unattributed render. Rebuild it natively or record an escalation.`,
      node: judged[0]!.sceneId,
    });
  }
  const failed = issues.some((issue) => issue.severity === "error") ||
    judged.some((scene) => scene.issues.some((issue) => issue.severity === "error"));
  return { scenes: judged, issues, verdict: failed ? "fail" : "pass" };
}
