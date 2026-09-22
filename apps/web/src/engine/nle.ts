/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The canonical advanced timing edits: lift, extract (ripple delete),
 * ripple trim, roll, slip, and slide. Every path here — keyboard, timeline
 * gesture, DAPI/MCP, agent action — must come through these functions, so
 * there is one ripple, one roll, one undo entry each, and the file hears
 * every one of them.
 *
 * They are written against the Diffusion-native model, not a track model:
 * a "sequence of clips" is the children of one parent, ordered by their
 * Computed start. Ripple scope is that parent: later siblings shift, other
 * parents (other layers) do not. Containers travel with their children via
 * `moveEntityTo`, so nested timing follows for free.
 *
 * Everything funnels into `timing.ts` (`trimIn`/`trimOut`/`moveEntityTo`/
 * `editTime`) and `DocumentEditor.remove`, which is what keeps the canvas,
 * the history, and the file saying the same thing. Multi-step ops run
 * inside one history gesture, so they undo as one meaningful edit.
 */

import {
	Cache,
	Computed,
	findAssetDuration,
	getParentEntity,
	getSourceWindow,
} from '@diffusionstudio/runtime';

import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';
import { editTime, moveEntityTo, trimIn, trimOut } from './timing';

import type { Entity, World } from 'koota';

/** A clip's playing span in timeline frames of its own parent. */
export type ClipSpan = { start: number; end: number };

/** What an extract reports: what left, and what moved to close up. */
export type RippleReport = { removed: Entity[]; shifted: Entity[]; delta: number };

/**
 * The parent's timeline children, oldest first: Computed start, ties in
 * document order. Children without Computed are not on a timeline.
 */
export function siblingsInTime(parent: Entity): Entity[] {
	const children = parent.get(Cache)?.children ?? [];
	return children
		.map((entity, index) => ({ entity, index }))
		.filter(({ entity }) => entity.has(Computed))
		.sort((a, b) => (a.entity.get(Computed)?.start ?? 0) - (b.entity.get(Computed)?.start ?? 0) || a.index - b.index)
		.map(({ entity }) => entity);
}

/** The clip's Computed span; the frames the timeline draws for it. */
export function clipSpan(entity: Entity): ClipSpan {
	const computed = entity.get(Computed);
	return { start: computed?.start ?? 0, end: computed?.end ?? 0 };
}

/**
 * Removes the clips and leaves the gap: the timeline keeps a hole where
 * they were. Later siblings do not move. One gesture, one undo step.
 */
export function lift(world: World, entities: Entity | Entity[]): Entity[] {
	const history = getEditHistory(world);
	history.beginGesture();
	try {
		return getDocumentEditor(world).remove(entities);
	} finally {
		history.endGesture();
	}
}

/**
 * Removes the clips and closes the gap (Premiere's extract / ripple
 * delete): every sibling at or after the hole's start, under the same
 * parent, shifts earlier by the hole's length. The hole is the union of
 * the removed spans, so a multi-select extract closes one hole per parent.
 */
export function extract(world: World, entities: Entity | Entity[]): RippleReport {
	const list = Array.isArray(entities) ? entities : [entities];
	if (list.length === 0) return { removed: [], shifted: [], delta: 0 };
	// Spans and parents are read before the removal: after it, the traits
	// the answers come from are gone with the entities.
	const doomed = list.map((entity) => ({ entity, parent: getParentEntity(entity), span: clipSpan(entity) }));
	const holeStart = Math.min(...doomed.map(({ span }) => span.start));
	const holeEnd = Math.max(...doomed.map(({ span }) => span.end));
	const delta = holeEnd - holeStart;
	const history = getEditHistory(world);
	history.beginGesture();
	try {
		const removed = getDocumentEditor(world).remove(list);
		const gone = new Set(removed);
		const shifted: Entity[] = [];
		if (delta > 0) {
			const parents = new Set(doomed.map(({ parent }) => parent).filter((parent) => parent !== null));
			for (const parent of parents) {
				for (const sibling of siblingsInTime(parent)) {
					if (gone.has(sibling)) continue;
					const span = clipSpan(sibling);
					if (span.start >= holeStart) {
						moveEntityTo(world, sibling, span.start - delta);
						shifted.push(sibling);
					}
				}
			}
		}
		return { removed, shifted, delta };
	} finally {
		history.endGesture();
	}
}

/**
 * Trims the clip's out point to timeline frame `frame` and ripples the
 * difference through its later siblings: extending the clip pushes them
 * later, shortening pulls them earlier. Returns the shift applied.
 */
export function rippleTrimOut(world: World, entity: Entity, frame: number): number {
	const parent = getParentEntity(entity);
	const oldEnd = clipSpan(entity).end;
	const delta = frame - oldEnd;
	if (delta === 0) return 0;
	const history = getEditHistory(world);
	history.beginGesture();
	try {
		trimOut(world, entity, frame);
		if (parent) {
			for (const sibling of siblingsInTime(parent)) {
				if (sibling === entity) continue;
				const span = clipSpan(sibling);
				if (span.start >= oldEnd) moveEntityTo(world, sibling, span.start + delta);
			}
		}
		return delta;
	} finally {
		history.endGesture();
	}
}

/**
 * Trims the clip's in point to timeline frame `frame` and ripples the
 * difference: the head moves and every sibling at or after the old head
 * shifts by the same amount, so no gap opens or closes past the trim.
 */
export function rippleTrimIn(world: World, entity: Entity, frame: number): number {
	const parent = getParentEntity(entity);
	const oldStart = clipSpan(entity).start;
	const delta = frame - oldStart;
	if (delta === 0) return 0;
	const history = getEditHistory(world);
	history.beginGesture();
	try {
		trimIn(world, entity, frame);
		if (parent) {
			for (const sibling of siblingsInTime(parent)) {
				if (sibling === entity) continue;
				const span = clipSpan(sibling);
				if (span.start >= oldStart) moveEntityTo(world, sibling, span.start + delta);
			}
		}
		return delta;
	} finally {
		history.endGesture();
	}
}

/**
 * Q — ripple-trims the clip's head to timeline frame `frame` and closes the
 * gap behind it: the head moves and the clip, with every sibling at or after
 * the old head, shifts earlier by the same amount, so the removed head leaves
 * no hole and nothing downstream drifts. Returns the shift applied; a frame
 * at or before the old head trims nothing. Unlike `rippleTrimIn`, which
 * pushes what follows later, this is the cut that keeps the timeline tight.
 */
export function rippleTrimPreviousToPlayhead(world: World, entity: Entity, frame: number): number {
	const parent = getParentEntity(entity);
	const oldStart = clipSpan(entity).start;
	const oldEnd = clipSpan(entity).end;
	if (!(oldStart < frame && frame < oldEnd)) return 0;
	const delta = frame - oldStart;
	const history = getEditHistory(world);
	history.beginGesture();
	try {
		// Snapshot who closes up before the trim moves anything: Computed
		// still holds the old timing in this call.
		const closing = parent
			? siblingsInTime(parent).filter((sibling) => clipSpan(sibling).start >= oldStart)
			: [entity];
		const starts = closing.map((sibling) => clipSpan(sibling).start);
		trimIn(world, entity, frame);
		// The clip returns to its old head; every sibling at or after that
		// head shifts earlier by the removed head.
		moveEntityTo(world, entity, oldStart);
		closing.forEach((sibling, index) => {
			if (sibling === entity) return;
			moveEntityTo(world, sibling, (starts[index] ?? oldStart) - delta);
		});
		return delta;
	} finally {
		history.endGesture();
	}
}

/**
 * Rolls the edit point at the end of `left` to timeline frame `frame`:
 * the left clip's out and the abutting right clip's in move together, so
 * their combined duration does not change. Returns the pair and the point
 * it actually landed on, or null when nothing abuts the point (a roll
 * needs two clips touching).
 *
 * A roll stretches one side's source — later eats the left clip's tail
 * handle, earlier the right clip's head — so the point stops where the
 * source does. Past the handle the runtime would clamp what plays while
 * the file said further, one state said twice; the applied point is what
 * both of them say.
 */
export function roll(world: World, left: Entity, frame: number): { left: Entity; right: Entity; applied: number } | null {
	const pair = rollPairAt(left);
	if (!pair) return null;
	if (frame === pair.point) return { left: pair.left, right: pair.right, applied: frame };
	const history = getEditHistory(world);
	history.beginGesture();
	try {
		const applied = writeRollPair(world, pair.left, pair.right, pair.point, frame);
		return { left: pair.left, right: pair.right, applied };
	} finally {
		history.endGesture();
	}
}

/**
 * The cut at the end of `left`: the abutting pair and the point, or null
 * when the end is not a cut between two clips (a roll needs two touching).
 */
export function rollPairAt(left: Entity): { left: Entity; right: Entity; point: number } | null {
	const parent = getParentEntity(left);
	if (!parent) return null;
	const point = clipSpan(left).end;
	const right = siblingsInTime(parent).find((sibling) => sibling !== left && clipSpan(sibling).start === point);
	if (!right) return null;
	return { left, right, point };
}

/**
 * Writes the pair to `frame`, clamped by source handles — the roll itself
 * without gesture bracketing. One-shot callers (the `roll` op above) bracket
 * it in a gesture; per-frame drag callers write through the drag's own
 * coalescing step instead, so a roll drag stays one undo step.
 */
export function writeRollPair(world: World, left: Entity, right: Entity, point: number, frame: number): number {
	let applied = frame;
	if (applied > point) applied = Math.min(applied, point + sourceTailroom(world, left));
	else if (applied < point) applied = Math.max(applied, point - sourceHeadroom(right));
	if (applied === point) return applied;
	trimOut(world, left, applied);
	trimIn(world, right, applied);
	return applied;
}

/**
 * Slips the clip's source window by `delta` frames: the timeline position
 * and duration stay, different source plays. Clamped to the media length
 * where one is known. Returns the applied shift, or 0 when the clip has
 * no finite window to slip (zero-length spans).
 */
export function slip(world: World, entity: Entity, delta: number): number {
	if (delta === 0) return 0;
	const window = getSourceWindow(entity);
	const span = clipSpan(entity);
	if (span.end - span.start <= 0) return 0;
	const media = findAssetDuration(world, entity);
	const applied = media === null ? delta : Math.max(-window.in, Math.min(media - window.out, delta));
	if (applied === 0) return 0;
	const history = getEditHistory(world);
	history.beginGesture();
	try {
		// Both sides are written so the slipped range is pinned whether or
		// not the node authored a window before.
		editTime(world, entity, 'sourceIn', window.in + applied);
		editTime(world, entity, 'sourceOut', window.out + applied);
		return applied;
	} finally {
		history.endGesture();
	}
}

/**
 * Slides the clip along the timeline by `delta` frames, pulling its
 * abutting neighbors' edges with it: the previous clip's out follows the
 * head, the next clip's in follows the tail. Neighbors that do not abut
 * are left alone, and the slide clamps to the neighbors' available source
 * handles where media lengths are known. Returns the applied shift.
 */
export function slide(world: World, entity: Entity, delta: number): number {
	if (delta === 0) return 0;
	const parent = getParentEntity(entity);
	if (!parent) return 0;
	const span = clipSpan(entity);
	const siblings = siblingsInTime(parent);
	const prev = [...siblings].reverse().find((sibling) => sibling !== entity && clipSpan(sibling).end === span.start);
	const next = siblings.find((sibling) => sibling !== entity && clipSpan(sibling).start === span.end);
	let applied = delta;
	// Only the neighbor the slide stretches needs a handle: sliding left
	// shrinks prev (free) and stretches next into earlier source; sliding
	// right stretches prev into later source and shrinks next (free).
	if (applied < 0 && next) applied = Math.max(applied, -sourceHeadroom(next));
	if (applied > 0 && prev) applied = Math.min(applied, sourceTailroom(world, prev));
	if (applied === 0) return 0;
	const history = getEditHistory(world);
	history.beginGesture();
	try {
		moveEntityTo(world, entity, span.start + applied);
		if (prev) trimOut(world, prev, span.start + applied);
		if (next) trimIn(world, next, span.end + applied);
		return applied;
	} finally {
		history.endGesture();
	}
}

/** Source frames before the clip's in point still inside its media. */
function sourceHeadroom(entity: Entity): number {
	return Math.max(0, getSourceWindow(entity).in);
}

/** Source frames past the clip's out point still inside its media. */
function sourceTailroom(world: World, entity: Entity): number {
	const window = getSourceWindow(entity);
	const media = findAssetDuration(world, entity);
	if (media === null) return Number.MAX_SAFE_INTEGER;
	return Math.max(0, media - window.out);
}
