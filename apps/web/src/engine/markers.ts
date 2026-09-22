/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The scene's markers: named flags pinned to frames of its timeline. Every
 * path here — the ruler flags, the M shortcuts, the inspector panel, the
 * timeline menu, DAPI/MCP, agent action — must come through these functions,
 * so there is one add, one remove, one move, one undo entry each, and the
 * file hears every one of them.
 *
 * A marker is authored on the scene (`<scene markers>`, the way `<scene
 * workarea>` is), and reconciled into the `Markers` trait the ruler and the
 * snapping read. One marker per frame: adding where one stands updates it,
 * so `at` is the marker's address. The file spells times in seconds and only
 * what differs from the defaults — a bare M press is `[{at: 7.5}]` — and an
 * emptied list is written as `false`, which the writer spells as the
 * attribute's absence.
 *
 * Everything funnels into `editProperty`, which is what keeps the trait, the
 * history and the file saying the same thing. Each op is one write, so it
 * undoes as one meaningful edit — and a ruler drag's burst of writes
 * coalesces into one step the way a trim's does, with no gesture bracketing
 * (see `editWorkarea`). Seeking is the exception: a marker jump moves the
 * playhead with `setPlayhead` and no word to the file, the way a step does.
 */

import {
	Computed,
	DEFAULT_MARKER_COLOR,
	FrameRate,
	Markers,
	framesToSeconds,
	getActiveEntity,
	setPlayhead,
	store,
} from '@diffusionstudio/runtime';

import { getDocumentEditor } from './editor';

import type { SceneMarker } from '@diffusionstudio/runtime';
import type { Entity, World } from 'koota';

/** What scene the op reads and writes; the active scene by default. */
export interface MarkerOptions {
	scene?: Entity;
}

export interface AddMarkerOptions extends MarkerOptions {
	/** Where the flag stands, in scene frames; the playhead by default. */
	at?: number;
	/** What the flag says; the standing name (or nothing) by default. */
	name?: string;
	/** Flag color, one of the palette names; the standing color by default. */
	color?: string;
}

export interface RemoveMarkerOptions extends MarkerOptions {
	/** Which flag to take off, in scene frames; the playhead by default. */
	at?: number;
}

export interface MoveMarkerOptions extends MarkerOptions {
	/** Where the flag stands now, in scene frames. */
	from: number;
	/** Where it moves to, in scene frames. */
	to: number;
}

export interface SeekMarkerOptions extends MarkerOptions {
	/** 'next' jumps past the playhead, 'prev' before it. */
	direction: 'next' | 'prev';
}

/** Re-exported for the panel and the flags: the runtime owns the default. */
export { DEFAULT_MARKER_COLOR };

/**
 * The flag palette, the one the schema, the ruler and the inspector share.
 * Anything outside it renders as the default.
 */
export const MARKER_COLORS: Readonly<Record<string, string>> = {
	yellow: '#F59E0B',
	blue: '#3B82F6',
	green: '#10B981',
	pink: '#EC4899',
	purple: '#A855F7',
	orange: '#F97316',
	cyan: '#06B6D4',
	red: '#EF4444',
};

/** The flag's paint: its palette hex, or the default's for anything else. */
export function markerColorHex(color: string): string {
	return MARKER_COLORS[color] ?? MARKER_COLORS[DEFAULT_MARKER_COLOR]!;
}

/** The scene's markers, earliest first; none while there is no scene. */
export function listMarkers(world: World, scene?: Entity): SceneMarker[] {
	const target = scene ?? getActiveEntity(world);
	if (!target) return [];
	return [...(target.get(Markers)?.list ?? [])].sort((a, b) => a.at - b.at);
}

/**
 * Pins a flag at `at` — the playhead when not given — or updates the one
 * standing there: its name and color are kept unless asked otherwise. Reads
 * the new flag back off the trait, so the caller gets what the scene says.
 */
export function addMarker(world: World, options: AddMarkerOptions = {}): SceneMarker | null {
	const scene = options.scene ?? getActiveEntity(world);
	if (!scene) return null;

	const at = Math.max(0, Math.round(options.at ?? playheadFrame(world, scene)));
	const standing = scene.get(Markers)?.list.find((marker) => marker.at === at);
	const name = options.name ?? standing?.name ?? '';
	const color = options.color ?? standing?.color ?? DEFAULT_MARKER_COLOR;

	const next = (scene.get(Markers)?.list ?? []).filter((marker) => marker.at !== at);
	next.push({ at, name, color });
	writeMarkers(world, scene, next);

	return scene.get(Markers)?.list.find((marker) => marker.at === at) ?? null;
}

/**
 * Takes the flag off `at` — the playhead when not given. False when no flag
 * stands there: there is nothing to take off and nothing is written.
 */
export function removeMarker(world: World, options: RemoveMarkerOptions = {}): boolean {
	const scene = options.scene ?? getActiveEntity(world);
	if (!scene) return false;

	const at = Math.round(options.at ?? playheadFrame(world, scene));
	const list = scene.get(Markers)?.list ?? [];
	if (!list.some((marker) => marker.at === at)) return false;

	writeMarkers(world, scene, list.filter((marker) => marker.at !== at));
	return true;
}

/**
 * Moves the flag from `from` to `to`. A flag already standing at `to` holds
 * its ground — the move is refused rather than clobbering it, here as in a
 * ruler drag passing over another flag. False when no flag stands at `from`,
 * when one stands at `to`, or when the move goes nowhere.
 */
export function moveMarker(world: World, options: MoveMarkerOptions): boolean {
	const scene = options.scene ?? getActiveEntity(world);
	if (!scene) return false;

	const from = Math.round(options.from);
	const to = Math.max(0, Math.round(options.to));
	if (from === to) return false;

	const list = scene.get(Markers)?.list ?? [];
	const moving = list.find((marker) => marker.at === from);
	if (!moving) return false;
	if (list.some((marker) => marker.at === to)) return false;

	const next = list.filter((marker) => marker.at !== from);
	next.push({ ...moving, at: to });
	writeMarkers(world, scene, next);
	return true;
}

/**
 * Takes every flag off the scene. False when it holds none: there is nothing
 * to take off and nothing is written.
 */
export function clearMarkers(world: World, options: MarkerOptions = {}): boolean {
	const scene = options.scene ?? getActiveEntity(world);
	if (!scene) return false;
	if ((scene.get(Markers)?.list.length ?? 0) === 0) return false;

	writeMarkers(world, scene, []);
	return true;
}

/**
 * Jumps the playhead to the next flag past it, or the previous flag before
 * it — strictly, so a jump from a flag lands on another one. Stops at the
 * ends: null when there is no flag in that direction. A seek, so the file
 * hears nothing (see the module note).
 */
export function seekMarker(world: World, options: SeekMarkerOptions): SceneMarker | null {
	const scene = options.scene ?? getActiveEntity(world);
	if (!scene) return null;

	const at = playheadFrame(world, scene);
	const list = [...(scene.get(Markers)?.list ?? [])].sort((a, b) => a.at - b.at);
	const found = options.direction === 'next'
		? list.find((marker) => marker.at > at)
		: [...list].reverse().find((marker) => marker.at < at);
	if (!found) return null;

	setPlayhead(world, scene, found.at);
	return found;
}

/** The playhead's frame on the scene, rounded — `localTime` may carry a fraction. */
function playheadFrame(world: World, scene: Entity): number {
	return Math.round(store(world, Computed).localTime[scene.id()] ?? 0);
}

/**
 * Writes the scene's flags whole: one write, one undo step. Only what differs
 * from the defaults is spelled, and an emptied list goes as `false`, which
 * the writer spells as the attribute's absence.
 */
function writeMarkers(world: World, scene: Entity, list: SceneMarker[]): void {
	const fps = world.get(FrameRate)?.value ?? 30;
	getDocumentEditor(world).editProperty(
		scene,
		'markers',
		list.length === 0
			? false
			: [...list]
				.sort((a, b) => a.at - b.at)
				.map((marker) => ({
					at: framesToSeconds(marker.at, fps),
					...(marker.name ? { name: marker.name } : {}),
					...(marker.color && marker.color !== DEFAULT_MARKER_COLOR ? { color: marker.color } : {}),
				})),
	);
}
