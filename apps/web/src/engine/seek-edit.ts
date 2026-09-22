/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Edit-point navigation: the previous/next cut around the playhead, across
 * the active scene and its direct sequence rows. Seeking only — the playhead
 * moves with `setPlayhead` and no word to the file, the way a marker jump
 * does. Returns the frame landed on, or null when no edit lies that way.
 */

import {
	Computed,
	getActiveEntity,
	isSequence,
	setPlayhead,
	store,
} from '@diffusionstudio/runtime';

import { clipSpan, siblingsInTime } from './nle';

import type { Entity, World } from 'koota';

/** Every edit point in play: each clip's head and tail, scene-root frames. */
function editPoints(scene: Entity): number[] {
	const points = new Set<number>();

	const collect = (parent: Entity): void => {
		for (const sibling of siblingsInTime(parent)) {
			if (isSequence(sibling)) {
				collect(sibling);
				continue;
			}
			const span = clipSpan(sibling);
			points.add(span.start);
			points.add(span.end);
		}
	};

	collect(scene);
	return [...points].sort((a, b) => a - b);
}

/** Parks the playhead on the nearest edit point before it. */
export function prevEditPoint(world: World): number | null {
	const scene = getActiveEntity(world);
	if (scene === null) return null;
	const frame = store(world, Computed).localTime[scene.id()] ?? 0;

	let prev: number | null = null;
	for (const point of editPoints(scene)) {
		if (point < frame) prev = point;
		else break;
	}
	if (prev === null) return null;
	setPlayhead(world, scene, prev);
	return prev;
}

/** Parks the playhead on the nearest edit point after it. */
export function nextEditPoint(world: World): number | null {
	const scene = getActiveEntity(world);
	if (scene === null) return null;
	const frame = store(world, Computed).localTime[scene.id()] ?? 0;

	for (const point of editPoints(scene)) {
		if (point > frame) {
			setPlayhead(world, scene, point);
			return point;
		}
	}
	return null;
}
