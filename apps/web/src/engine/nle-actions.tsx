/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The human NLE verbs: thin wrappers over the canonical timing edits in
 * `./nle` (`lift`, `extract`, `rippleTrimIn/Out`, `roll`, `slip`, `slide`),
 * `./split` and `./timing`, for buttons, shortcuts and timeline gestures.
 *
 * Nothing here edits the document its own way: every function below funnels
 * into the same canonical operation the DAPI `timeline_edit` handler calls,
 * so a human ripple-delete and an agent ripple-delete are the same edit,
 * with the same history step and the same source sync.
 */

import {
	Computed,
	getActiveEntity,
	getParentEntity,
	getSelection,
	isSequence,
	Selected,
	store,
} from '@diffusionstudio/runtime';

import { clipSpan, extract, lift, rippleTrimOut, rippleTrimPreviousToPlayhead, siblingsInTime, slide, slip, type RippleReport } from './nle';

import type { Entity, World } from 'koota';

/** Removes the selection and leaves the gap: Premiere's lift. */
export function liftSelection(world: World): Entity[] {
	return lift(world, getSelection(world));
}

/** Removes the selection and closes the gap: Premiere's ripple delete. */
export function rippleDeleteSelection(world: World): RippleReport {
	return extract(world, getSelection(world));
}

/**
 * The clips a Q/W press trims: the ones playing under the playhead, with
 * sequence rows opened the way `splitUnits` opens them — a sequence is not
 * a clip, so the trim goes to whichever of its children the playhead is
 * over, never to both the row and its contents in one press.
 */
function clipsUnderPlayhead(scene: Entity, frame: number): Entity[] {
	const found: Entity[] = [];

	const walk = (entity: Entity): void => {
		if (isSequence(entity)) {
			for (const child of siblingsInTime(entity)) walk(child);
			return;
		}
		const span = clipSpan(entity);
		if (span.start < frame && frame < span.end) found.push(entity);
	};

	for (const child of siblingsInTime(scene)) walk(child);

	// One edit unit per parent: each canonical ripple already shifts its
	// parent's later siblings, so trimming two overlapping siblings would
	// shift the downstream twice. A selected clip wins its row, otherwise
	// the topmost (last drawn) does.
	const picked = new Map<Entity, Entity>();
	for (const clip of found) {
		const parent = getParentEntity(clip) ?? scene;
		const prev = picked.get(parent);
		if (prev === undefined || clip.has(Selected) || !prev.has(Selected)) picked.set(parent, clip);
	}
	return [...picked.values()];
}

/**
 * Q — removes everything from the previous edit to the playhead: every clip
 * under the playhead loses its head up to it, and what follows closes up so
 * the timeline stays tight. A playhead in a gap trims nothing.
 */
export function rippleTrimPrevToPlayhead(world: World): number {
	const scene = getActiveEntity(world);
	if (scene === null) return 0;
	const frame = store(world, Computed).localTime[scene.id()] ?? 0;

	let applied = 0;
	for (const clip of clipsUnderPlayhead(scene, frame)) {
		applied += Math.abs(rippleTrimPreviousToPlayhead(world, clip, frame));
	}
	return applied;
}

/**
 * W — removes everything from the playhead to the next edit: every clip
 * under the playhead loses its tail from it, and what follows closes up.
 * A playhead in a gap trims nothing.
 */
export function rippleTrimNextToPlayhead(world: World): number {
	const scene = getActiveEntity(world);
	if (scene === null) return 0;
	const frame = store(world, Computed).localTime[scene.id()] ?? 0;

	let applied = 0;
	for (const clip of clipsUnderPlayhead(scene, frame)) {
		applied += Math.abs(rippleTrimOut(world, clip, frame));
	}
	return applied;
}

/** Slips the selection's source windows by `delta` frames; the timeline does not move. */
export function slipSelectionBy(world: World, delta: number): number {
	let applied = 0;
	for (const entity of getSelection(world)) applied += slip(world, entity, delta);
	return applied;
}

/** Slides the selection along the timeline by `delta` frames. */
export function slideSelectionBy(world: World, delta: number): number {
	let applied = 0;
	for (const entity of getSelection(world)) applied += slide(world, entity, delta);
	return applied;
}
