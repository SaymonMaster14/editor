/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Scene ducking planner: turns the `<Scene ducking>` setup plus the placed
// key-bus audio (dialogue waveforms, gains, fades, trims) into one gain
// curve over the scene's timeline, stored on the scene as DuckPlanHandle.
// The motion system samples it per frame for clips on the ducked buses, so
// realtime playback and offline export follow the same automation.
//
// The key envelope is placed power: every key clip's waveform bytes at 800
// peaks/second, un-warped to linear amplitude ((b/255)^1.25 inverts the
// waveform worker's |x|^0.8 warp), scaled by the clip's volume and fades,
// summed as power across overlapping clips. Clips that are muted, hidden,
// soloed-out, or have no waveform contribute nothing — the same silence
// the playback system gives them.

import { Not } from 'koota';
import {
	WAVEFORM_PEAKS_PER_SECOND, deriveWaveform,
} from '@diffusionstudio/assets';
import {
	amplitudeToDb, dbToAmplitude, duckingCurve, fadeGainDbAt, powerToDb,
} from '@diffusionstudio/audio';
import {
	AssetId, ChildOf, Computed, Ducking, DuckPlanHandle, Fade,
	FrameRate, Geometry, Hidden, Library, MixBus, Muted, Paint, Soloed, Volume,
	Workarea,
} from '../traits';
import { getAsset, getAssetFile } from '../actions/assets';
import { getParentNode } from '../queries/hierarchy';
import { getAudioWindow } from '../utils/time';

import type { Entity, World } from 'koota';
import type { GainPoint } from '@diffusionstudio/audio';
import type { DuckingConfig } from '../traits';

/** Envelope grid step, seconds: 20 points a second is plenty for ballistics. */
export const DUCK_PLAN_STEP_SECONDS = 0.05;

export interface DuckPlan {
	/** The signature this curve was planned from (see duckingSignature). */
	signature: string;
	keyBus: string;
	duckBuses: string[];
	/** Gain over the scene timeline, ascending seconds, dB (≤ 0). */
	curve: GainPoint[];
	/** Deepest point of the curve, for inspect/debug. */
	minGainDb: number;
}

/** Linear interpolation over the plan's curve, clamped past both ends. */
export function sampleDuckCurve(plan: DuckPlan, timeSeconds: number): number {
	const curve = plan.curve;
	if (curve.length === 0) return 0;
	if (timeSeconds <= curve[0]!.time) return curve[0]!.gainDb;
	const last = curve[curve.length - 1]!;
	if (timeSeconds >= last.time) return last.gainDb;

	let lo = 0;
	let hi = curve.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (curve[mid]!.time <= timeSeconds) lo = mid;
		else hi = mid;
	}
	const from = curve[lo]!;
	const to = curve[hi]!;
	const span = to.time - from.time;
	if (span <= 0) return from.gainDb;
	const progress = (timeSeconds - from.time) / span;
	return from.gainDb + (to.gainDb - from.gainDb) * progress;
}

interface KeyClip {
	assetId: string;
	/** Audible window, timeline frames. */
	start: number;
	end: number;
	origin: number;
	rate: number;
	volumeDb: number;
	fadeIn: number;
	fadeOut: number;
}

/** Every descendant clip entity of `scene`, groups recursed into. */
function sceneClips(world: World, scene: Entity): Entity[] {
	const clips: Entity[] = [];
	const stack: Entity[] = [scene];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const child of world.query(ChildOf(current))) {
			if (child.has(Geometry)) clips.push(child);
			stack.push(child);
		}
	}
	return clips;
}

function ancestorHas(entity: Entity, has: (entity: Entity) => boolean): boolean {
	let current: Entity | null = getParentNode(entity);
	while (current) {
		if (has(current)) return true;
		current = getParentNode(current);
	}
	return false;
}

/** The asset id whose audio `entity` plays: its own, else its media paint's. */
function clipAssetId(world: World, entity: Entity): string | undefined {
	const own = entity.get(AssetId)?.value;
	if (own) return own;
	for (const fill of world.query(ChildOf(entity), Paint, Not(Geometry), Not(Hidden))) {
		const id = fill.get(AssetId)?.value;
		if (id) return id;
	}
	return undefined;
}

/**
 * The scene's key-bus clips as placed audio: key-bus assignment, an asset,
 * and actually audible — muted, hidden, and soloed-out clips key nothing,
 * matching what the playback system schedules for them.
 */
function collectKeyClips(world: World, scene: Entity, keyBus: string): KeyClip[] {
	const soloActive = world.query(Soloed).length > 0;
	const clips: KeyClip[] = [];

	for (const entity of sceneClips(world, scene)) {
		if ((entity.get(MixBus)?.value ?? 'master') !== keyBus) continue;
		if (entity.has(Muted) || ancestorHas(entity, (e) => e.has(Muted))) continue;
		if (entity.has(Hidden)) continue;
		if (soloActive && !entity.has(Soloed) && !ancestorHas(entity, (e) => e.has(Soloed))) continue;

		const assetId = clipAssetId(world, entity);
		if (!assetId) continue;

		const computed = entity.get(Computed);
		const window = getAudioWindow(entity);
		if (window.end <= window.start) continue;
		const fade = entity.get(Fade);

		clips.push({
			assetId,
			start: window.start,
			end: window.end,
			origin: computed?.origin ?? 0,
			rate: computed?.playbackRate || 1,
			volumeDb: entity.get(Volume)?.value ?? 0,
			fadeIn: fade?.in ?? 0,
			fadeOut: fade?.out ?? 0,
		});
	}

	return clips;
}

function sceneSpan(world: World, scene: Entity): { start: number; end: number } {
	const fps = world.get(FrameRate)?.value ?? 30;
	const workarea = scene.get(Workarea);
	if (workarea && workarea.end > workarea.start) {
		return { start: workarea.start / fps, end: workarea.end / fps };
	}
	const computed = scene.get(Computed);
	const start = (computed?.start ?? 0) / fps;
	const duration = (computed?.duration ?? computed?.end ?? 0) / fps;
	return { start, end: Math.max(start, duration) };
}

function configFingerprint(config: DuckingConfig): string {
	return [
		config.keyBus,
		[...config.duckBuses].sort().join(','),
		config.thresholdDb, config.depthDb,
		config.attackMs, config.holdMs, config.releaseMs,
	].join(':');
}

/**
 * What the scene's duck curve depends on: config, frame rate, span, and
 * every key clip's asset, placement, rate, and gain. Null when the scene
 * carries no ducking setup. The playback system compares this per tick and
 * replans only when it changes.
 */
export function duckingSignature(world: World, scene: Entity): string | null {
	const config = scene.get(Ducking);
	if (!config) return null;

	const fps = world.get(FrameRate)?.value ?? 30;
	const span = sceneSpan(world, scene);
	const clips = collectKeyClips(world, scene, config.keyBus)
		.map((clip) => [
			clip.assetId, clip.start, clip.end, clip.origin, clip.rate,
			clip.volumeDb, clip.fadeIn, clip.fadeOut,
		].join(':'))
		.sort()
		.join('|');

	return [fps, span.start, span.end, configFingerprint(config), clips].join('~');
}

/** A key clip's waveform bytes, through the project cache where there is one. */
async function clipWaveform(
	world: World, assetId: string,
): Promise<Uint8ClampedArray | null> {
	const asset = getAsset(world, assetId);
	if (asset?.type !== 'AUDIO' && asset?.type !== 'VIDEO') return null;

	const cache = world.get(Library)?.cache;
	try {
		if (cache) {
			const file = await cache.waveform(asset);
			if (!file) return null;
			return new Uint8ClampedArray(await file.arrayBuffer());
		}
		return await deriveWaveform(await getAssetFile(asset));
	} catch {
		// An unreadable waveform keys nothing rather than breaking the mix.
		return null;
	}
}

interface PlacedKey extends KeyClip {
	peaks: Uint8ClampedArray;
}

/**
 * Plan the scene's duck curve for `signature` (null when the scene no
 * longer carries a ducking setup). Waveform reads run concurrently; the
 * envelope grid itself is one pass per key clip.
 */
export async function planDucking(
	world: World, scene: Entity, signature: string,
): Promise<DuckPlan | null> {
	const config = scene.get(Ducking);
	if (!config || duckingSignature(world, scene) !== signature) return null;

	const fps = world.get(FrameRate)?.value ?? 30;
	const span = sceneSpan(world, scene);
	const clips = collectKeyClips(world, scene, config.keyBus);

	const placed: PlacedKey[] = [];
	await Promise.all(clips.map(async (clip) => {
		const peaks = await clipWaveform(world, clip.assetId);
		if (peaks && peaks.length > 0) placed.push({ ...clip, peaks });
	}));

	const envelope: { time: number; levelDb: number }[] = [];
	const steps = Math.max(0, Math.ceil((span.end - span.start) / DUCK_PLAN_STEP_SECONDS));
	for (let step = 0; step <= steps; step++) {
		const time = span.start + step * DUCK_PLAN_STEP_SECONDS;
		const frame = time * fps;
		let power = 0;

		for (const clip of placed) {
			if (frame < clip.start || frame >= clip.end) continue;
			const sourceSeconds = ((frame - clip.origin) * clip.rate) / fps;
			const index = Math.floor(sourceSeconds * WAVEFORM_PEAKS_PER_SECOND);
			if (index < 0 || index >= clip.peaks.length) continue;
			const byte = clip.peaks[index]!;
			if (byte <= 0) continue;

			const startSeconds = clip.start / fps;
			const durationSeconds = (clip.end - clip.start) / fps;
			const gainDb = clip.volumeDb + fadeGainDbAt(time - startSeconds, {
				in: clip.fadeIn, out: clip.fadeOut, duration: durationSeconds,
			});
			// Inverts the waveform worker's |x|^0.8 warp (byte 255 = full scale).
			const amplitude = (byte / 255) ** 1.25 * dbToAmplitude(gainDb);
			power += amplitude * amplitude;
		}

		envelope.push({ time, levelDb: power > 0 ? powerToDb(power) : amplitudeToDb(0) });
	}

	const curve = duckingCurve(envelope, {
		thresholdDb: config.thresholdDb,
		depthDb: config.depthDb,
		attackMs: config.attackMs,
		releaseMs: config.releaseMs,
		holdMs: config.holdMs,
	});

	let minGainDb = 0;
	for (const point of curve) minGainDb = Math.min(minGainDb, point.gainDb);

	return {
		signature,
		keyBus: config.keyBus,
		duckBuses: [...config.duckBuses],
		curve,
		minGainDb,
	};
}

/**
 * Signatures with a plan already being computed, by world and scene. A plain
 * map inside: koota entities are numbers, which a weak map cannot key. (A
 * recycled entity id cannot collide stale either way — a plan installs only
 * when its signature still matches the world's current one.)
 */
const inflight = new WeakMap<World, Map<Entity, string>>();

function inflightFor(world: World): Map<Entity, string> {
	let flights = inflight.get(world);
	if (!flights) {
		flights = new Map();
		inflight.set(world, flights);
	}
	return flights;
}

/**
 * Bring the scene's duck plan up to date: drop it when the setup is gone,
 * keep it when the signature matches, otherwise replan in the background
 * (one flight per scene) and install the result if it is still current.
 * Cheap to call every tick — the signature walk is the cost when idle.
 */
export function refreshDucking(world: World, scene: Entity): void {
	const signature = duckingSignature(world, scene);

	if (signature === null) {
		if (scene.has(DuckPlanHandle)) scene.remove(DuckPlanHandle);
		return;
	}

	if (scene.get(DuckPlanHandle)?.signature === signature) return;
	const flights = inflightFor(world);
	if (flights.get(scene) === signature) return;
	flights.set(scene, signature);

	planDucking(world, scene, signature).then(
		(plan) => {
			flights.delete(scene);
			if (!plan || duckingSignature(world, scene) !== signature) return;
			try {
				scene.add(DuckPlanHandle);
				scene.set(DuckPlanHandle, plan);
			} catch {
				// The scene went away mid-plan; nothing to install onto.
			}
		},
		(error) => {
			flights.delete(scene);
			console.warn('Ducking plan failed; the mix plays unducked.', error);
		},
	);
}

/**
 * Awaitable version of the refresh: plans (when the signature changed) and
 * installs before returning. The offline encoder settles every scene's
 * curve before frame zero with this — the background replan above would
 * otherwise land mid-render (or after it), ducking nondeterministically.
 */
export async function ensureDuckPlan(world: World, scene: Entity): Promise<void> {
	const signature = duckingSignature(world, scene);
	if (signature === null) {
		if (scene.has(DuckPlanHandle)) scene.remove(DuckPlanHandle);
		return;
	}
	if (scene.get(DuckPlanHandle)?.signature === signature) return;
	const plan = await planDucking(world, scene, signature);
	if (!plan || duckingSignature(world, scene) !== signature) return;
	try {
		scene.add(DuckPlanHandle);
		scene.set(DuckPlanHandle, plan);
	} catch {
		// The scene went away mid-plan; nothing to install onto.
	}
}
