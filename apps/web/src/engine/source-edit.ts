/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The source side of editing: what the source monitor holds, the in/out
 * range marked on it, and the two edits that land the range on the
 * timeline — insert and overwrite. Every path here — the monitor UI, the
 * I/O and insert/overwrite shortcuts, DAPI/MCP, agent action — must come
 * through these functions, so there is one insert, one overwrite, one undo
 * entry each, and the file hears every one of them.
 *
 * Times on the monitor are source seconds, the way an asset measures
 * itself; `at` is a scene frame, the space Computed spans live in. The
 * monitor state itself is the `SourceMonitor` world trait, editor state
 * the same way `AssetSelection` is: which asset is loaded and what range
 * is marked on it is looked-at, not authored, and never reaches the file.
 *
 * Everything funnels into `insert-asset` (`insertAsset`), `timing.ts`,
 * `nle.ts` and `overlap.ts`, which is what keeps the canvas, the history
 * and the file saying the same thing. Multi-step ops run inside one
 * history gesture, so they undo as one meaningful edit.
 */

import {
	Computed,
	FrameRate,
	Library,
	Sequential,
	Source,
	framesToSeconds,
	getActiveEntity,
	handOffDecoders,
	isGroup,
	isSequence,
	secondsToFrames,
	store,
} from '@diffusionstudio/runtime';
import { assetName } from '@diffusionstudio/assets';
import { parseSource } from '@diffusionstudio/jsx';

import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';
import { insertAsset } from './insert-asset';
import { clipSpan, siblingsInTime } from './nle';
import { resolveSpanOverlap } from './overlap';
import { cloneFramesForSplit, clonePeaksForSplit } from './timeline';
import { editTime, moveEntityTo, trimIn, trimOut } from './timing';
import { SourceMonitor } from './traits';

import type { Asset } from '@diffusionstudio/assets';
import type { Entity, World } from 'koota';

/** How long a still plays when it lands with no range marked — the Premiere-like default. */
export const DEFAULT_STILL_SECONDS = 5;

/** A marked range on a library asset, in source seconds. */
export type SourceRange = { assetId: string; in: number; out: number };

export interface SourceEditOptions {
	/** The asset to cut from; the monitor's loaded asset by default. */
	assetId?: string;
	/** The range to land, in source seconds; the monitor's marked range by default. */
	in?: number;
	/** The range to land, in source seconds; the monitor's marked range by default. */
	out?: number;
	/** Where on the timeline the clip lands, in scene frames; the playhead by default. */
	at?: number;
	/** What to land it under; the active scene by default. */
	parent?: Entity;
}

/** What an insert or overwrite landed: the clip, and the frames it took. */
export type SourceEditReport = { entity: Entity; at: number; duration: number } | null;

/**
 * Loads `assetId` into the source monitor and marks its whole run: a fresh
 * asset is ranged end to end, so insert lands all of it until the editor
 * marks otherwise. Stills get the default still length — they have no run
 * of their own. `null` unloads the monitor.
 */
export function loadSourceMonitor(world: World, assetId: string | null): void {
	if (assetId === null) {
		world.set(SourceMonitor, { assetId: null, position: 0, in: 0, out: 0 });
		return;
	}
	const duration = mediaDuration(world.get(Library)?.get(assetId)) ?? DEFAULT_STILL_SECONDS;
	world.set(SourceMonitor, { assetId, position: 0, in: 0, out: duration });
}

/** Moves the monitor's preview to source second `at`, clamped to the media's run. */
export function scrubSourceMonitor(world: World, at: number): void {
	const monitor = world.get(SourceMonitor);
	if (!monitor?.assetId) return;
	const duration = mediaDuration(world.get(Library)?.get(monitor.assetId)) ?? DEFAULT_STILL_SECONDS;
	world.set(SourceMonitor, { ...monitor, position: clamp(at, 0, duration) });
}

/**
 * Marks the range's in point at source second `at` — the monitor's preview
 * position when not given. The out point follows the in point past it: a
 * range reads forward, so marking in past out collapses the range there
 * rather than leaving it backwards.
 */
export function markIn(world: World, at?: number): void {
	const monitor = world.get(SourceMonitor);
	if (!monitor?.assetId) return;
	const duration = mediaDuration(world.get(Library)?.get(monitor.assetId)) ?? DEFAULT_STILL_SECONDS;
	const point = clamp(at ?? monitor.position, 0, duration);
	world.set(SourceMonitor, { ...monitor, in: point, out: Math.max(monitor.out, point) });
}

/**
 * Marks the range's out point at source second `at` — the monitor's preview
 * position when not given. Mirrors `markIn`: the in point retreats before
 * an out point marked earlier than it.
 */
export function markOut(world: World, at?: number): void {
	const monitor = world.get(SourceMonitor);
	if (!monitor?.assetId) return;
	const duration = mediaDuration(world.get(Library)?.get(monitor.assetId)) ?? DEFAULT_STILL_SECONDS;
	const point = clamp(at ?? monitor.position, 0, duration);
	world.set(SourceMonitor, { ...monitor, in: Math.min(monitor.in, point), out: point });
}

/**
 * The monitor's marked range, or null when nothing is loaded. A collapsed
 * range (out at or before in) is not a range: callers wanting "the whole
 * run" say so by loading the asset, which marks it whole.
 */
export function sourceMonitorRange(world: World): SourceRange | null {
	const monitor = world.get(SourceMonitor);
	if (!monitor?.assetId || monitor.out <= monitor.in) return null;
	return { assetId: monitor.assetId, in: monitor.in, out: monitor.out };
}

/**
 * Lands the source range on the timeline at `at`, opening room for it:
 * the clip under the point is cut there, and everything at or after the
 * point shifts later by the landed length. The ripple scope is the parent,
 * the way `extract`'s is — other parents do not move. One gesture, one
 * undo step.
 */
export function insertEdit(world: World, options: SourceEditOptions = {}): SourceEditReport {
	const resolved = resolveSourceEdit(world, options);
	if (!resolved) return null;
	const { asset, inSeconds, outSeconds, parent, at } = resolved;
	const fps = world.get(FrameRate)?.value ?? 30;
	const duration = secondsToFrames(outSeconds - inSeconds, fps);
	if (duration <= 0) return null;

	const history = getEditHistory(world);
	history.beginGesture();
	try {
		// An insert into the middle of a clip cuts it there, Premiere-style,
		// so the halves are what the shift moves apart. Containers straddling
		// the point are left whole: cutting a sequence or group in two is not
		// a clip insert, and duplicating one by splitting it would be. To cut
		// inside one, target it as the parent instead.
		for (const sibling of siblingsInTime(parent)) {
			if (isSequence(sibling) || isGroup(sibling)) continue;
			const span = clipSpan(sibling);
			if (span.start < at && at < span.end) splitOne(world, sibling, at);
		}
		for (const sibling of siblingsInTime(parent)) {
			const span = clipSpan(sibling);
			if (span.start >= at) moveEntityTo(world, sibling, span.start + duration);
		}
		const entity = placeSourceClip(world, asset, parent, at, inSeconds, outSeconds, fps);
		return entity ? { entity, at, duration } : null;
	} finally {
		history.endGesture();
	}
}

/**
 * Lands the source range on the timeline at `at` without moving anything:
 * the new clip wins the frames it covers. Under a sequence that means the
 * covered siblings give way — trimmed, removed, or split around it, the
 * same settle a drop gets; under anything else the siblings are layers,
 * which overlap freely, and are left alone. One gesture, one undo step.
 */
export function overwriteEdit(world: World, options: SourceEditOptions = {}): SourceEditReport {
	const resolved = resolveSourceEdit(world, options);
	if (!resolved) return null;
	const { asset, inSeconds, outSeconds, parent, at } = resolved;
	const fps = world.get(FrameRate)?.value ?? 30;
	const duration = secondsToFrames(outSeconds - inSeconds, fps);
	if (duration <= 0) return null;

	const history = getEditHistory(world);
	history.beginGesture();
	try {
		const entity = placeSourceClip(world, asset, parent, at, inSeconds, outSeconds, fps);
		if (!entity) return null;
		if (parent.has(Sequential)) {
			resolveSpanOverlap(world, parent, at, at + duration, new Set([entity]));
		}
		return { entity, at, duration };
	} finally {
		history.endGesture();
	}
}

/** The media's run in source seconds, or null for what has no run (a still). */
function mediaDuration(asset: Asset | undefined): number | null {
	if (!asset || !('duration' in asset) || typeof asset.duration !== 'number') return null;
	return asset.duration;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * A readable id no element holds yet, from the asset's file stem: `street`,
 * then `street-2`, `street-3`, … . The writer keeps an authored id as the
 * element's address, so this is the name the placed clip answers to from
 * the sync on — worth a scan of the world's stamps to get right.
 */
function freshClipId(world: World, asset: Asset): string {
	const slug = assetName(asset)
		.replace(/\.[^.]+$/, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'clip';
	const taken = new Set<string>();
	for (const entity of world.query(Source)) {
		const stamp = entity.get(Source)?.value;
		if (!stamp) continue;
		taken.add(stamp);
		const parsed = parseSource(stamp);
		if (parsed !== undefined) taken.add(String(parsed.locator));
	}
	if (!taken.has(slug)) return slug;
	for (let n = 2; n < 1000; n++) {
		if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
	}
	return `${slug}-${Date.now()}`;
}

type ResolvedSourceEdit = {
	asset: Asset;
	inSeconds: number;
	outSeconds: number;
	parent: Entity;
	at: number;
};

/**
 * Settles what an insert or overwrite was asked for: the asset (named, or
 * the monitor's), the range (given, or the monitor's, or the whole run),
 * the parent (given, or the active scene), and the landing frame (given, or
 * the playhead). Null when there is no asset, no parent, or nothing to land
 * under — `insertAsset`'s own refusals, read before the gesture starts so a
 * refused edit shifts nothing.
 */
function resolveSourceEdit(world: World, options: SourceEditOptions): ResolvedSourceEdit | null {
	const monitor = world.get(SourceMonitor);
	const assetId = options.assetId ?? monitor?.assetId ?? null;
	const asset = assetId ? world.get(Library)?.get(assetId) : undefined;
	if (!asset) return null;

	const duration = mediaDuration(asset) ?? DEFAULT_STILL_SECONDS;
	let inSeconds = clamp(options.in ?? monitor?.in ?? 0, 0, duration);
	let outSeconds = clamp(options.out ?? monitor?.out ?? duration, 0, duration);
	if (outSeconds <= inSeconds) {
		inSeconds = 0;
		outSeconds = duration;
	}

	const parent = options.parent ?? getActiveEntity(world);
	if (!parent || !parent.get(Source)?.value) return null;

	const scene = getActiveEntity(world);
	const at = options.at ?? (scene ? (store(world, Computed).localTime[scene.id()] ?? 0) : 0);
	return { asset, inSeconds, outSeconds, parent, at: Math.max(0, at) };
}

/**
 * Puts the asset on the timeline at `at` playing `inSeconds..outSeconds`:
 * an `insertAsset` drop, then the source window and the out point pinned.
 * The end is pinned explicitly — without an authored end the clip would run
 * to the end of its media instead of the end of the range. The clip is
 * authored with a readable id of its own, so whoever placed it (a human
 * reading the file, an agent pointing at it next) gets a name back rather
 * than the minted stamp an anonymous insert would sync as.
 */
function placeSourceClip(
	world: World,
	asset: Asset,
	parent: Entity,
	at: number,
	inSeconds: number,
	outSeconds: number,
	fps: number,
): Entity | null {
	const entity = insertAsset(world, asset, { parent, start: framesToSeconds(at, fps), id: freshClipId(world, asset) });
	if (!entity) return null;
	const inFrames = secondsToFrames(inSeconds, fps);
	const outFrames = secondsToFrames(outSeconds, fps);
	editTime(world, entity, 'sourceIn', inFrames);
	editTime(world, entity, 'sourceOut', outFrames);
	editTime(world, entity, 'end', at + (outFrames - inFrames));
	return entity;
}

/**
 * Cuts one clip in two at `frame`, the same cut `splitAtPlayhead` makes:
 * copied where it stands before anything is trimmed, so the copy is spelled
 * from the whole clip. The decoders and the decoded pictures and peaks move
 * to the halves with it, rather than being decoded all over again.
 */
function splitOne(world: World, entity: Entity, frame: number): void {
	const [pair] = getDocumentEditor(world).duplicateInPlace([entity]);
	trimOut(world, entity, frame);
	if (pair) {
		trimIn(world, pair.copy, frame);
		handOffDecoders(world, entity, pair.copy);
		clonePeaksForSplit(entity.id(), pair.copy.id());
		cloneFramesForSplit(entity.id(), pair.copy.id());
	}
}
