/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { stereoGains } from '@diffusionstudio/audio';
import { store } from '../world/store';
import { Muted, Computed, AudioEngine } from '../traits';
import { attempt } from '../utils/async';
import { assert } from '../utils/assert';

import type { Entity, World } from 'koota';

/**
 * Per-entity audio bus. Each clip and each scene gets its own gain node,
 * fed through an explicit equal-power panner: a channel normalizer (any
 * input becomes stereo — mono up-mixes, surround folds down), a splitter,
 * one gain per side, and a merger back into the volume gain. Child buses
 * connect directly into the parent bus's input; there is no per-track
 * sub-mix anymore (each clip is its own layer).
 *
 * The panning is explicit gains rather than a StereoPannerNode on purpose:
 * measured in this Electron's OfflineAudioContext, the native node passes
 * stereo through untouched at center (unity instead of −3 dB) and sums
 * both channels into the left rail at hard-left (+6 dB instead of +3 dB),
 * while its mono branch behaves to spec. Per-channel gains have no such
 * input-dependent branch — mono and stereo take one transfer function.
 */
export class AudioBus {
	public context: BaseAudioContext;

	private gain: GainNode;
	private downmix: GainNode;
	private splitter: ChannelSplitterNode;
	private panL: GainNode;
	private panR: GainNode;
	private merger: ChannelMergerNode;
	private entity: Entity;
	private world: World;
	private _input: AudioNode;

	public constructor(world: World, entity: Entity) {
		const context = world.get(AudioEngine)?.context;
		assert(context, 'World has no audio context');
		this.context = context;
		this.gain = context.createGain();
		// Explicit stereo: 'speakers' up-mixes mono to dual-mono and folds
		// surround down, so the splitter always sees two real channels.
		this.downmix = context.createGain();
		this.downmix.channelCount = 2;
		this.downmix.channelCountMode = 'explicit';
		this.downmix.channelInterpretation = 'speakers';
		this.splitter = context.createChannelSplitter(2);
		this.panL = context.createGain();
		this.panR = context.createGain();
		this.merger = context.createChannelMerger(2);
		this.downmix.connect(this.splitter);
		this.splitter.connect(this.panL, 0);
		this.splitter.connect(this.panR, 1);
		this.panL.connect(this.merger, 0, 0);
		this.panR.connect(this.merger, 0, 1);
		this.merger.connect(this.gain);
		this._input = this.downmix;
		this.entity = entity;
		this.world = world;
	}

	public get input(): AudioNode {
		return this._input;
	}

	public getGain(): GainNode {
		return this.gain;
	}

	public sync(when?: number): void {
		this.setParam(this.gain.gain, this.getVolume(), when);
		const pan = store(this.world, Computed).pan[this.entity.id()] ?? 0;
		const { left, right } = stereoGains(pan);
		this.setParam(this.panL.gain, left, when);
		this.setParam(this.panR.gain, right, when);
	}

	/**
	 * Assign an audio param: a scheduled step in an offline render — the
	 * build runs ahead of the render thread by a timing-dependent amount,
	 * so live writes land automation early by a jittering margin, while a
	 * step lands sample-accurately — and a live write everywhere else.
	 */
	private setParam(param: AudioParam, value: number, when: number | undefined): void {
		if (when !== undefined && Number.isFinite(when) && this.context instanceof OfflineAudioContext) {
			param.setValueAtTime(value, Math.max(0, when));
		} else {
			param.value = value;
		}
	}

	public connect(node: AudioNode) {
		this.gain.connect(node);
	}

	public mute(when?: number): void {
		if (when !== undefined && Number.isFinite(when) && this.context instanceof OfflineAudioContext) {
			// A live write would lose to the automation sync() already
			// scheduled, so cancel the future and hold silence from here.
			this.gain.gain.cancelScheduledValues(Math.max(0, when));
			this.gain.gain.setValueAtTime(0, Math.max(0, when));
		} else {
			this.gain.gain.value = 0;
		}
	}

	public disconnect() {
		attempt(() => this.gain.disconnect());
		attempt(() => this.downmix.disconnect());
		attempt(() => this.splitter.disconnect());
		attempt(() => this.panL.disconnect());
		attempt(() => this.panR.disconnect());
		attempt(() => this.merger.disconnect());
		this._input = this.downmix;
	}

	private getVolume(): number {
		const computed = store(this.world, Computed);
		const eid = this.entity.id();
		// Base volume (with animations, keyframes, fades composed by motion)
		// times the ducking automation, both in dB.
		const volumeDb = (computed.volume[eid] ?? 0) + (computed.duckDb[eid] ?? 0);
		const muted = this.entity.has(Muted);

		/** Minimum dB value: treated as silence (maps to linear gain 0). */
		if (muted || volumeDb === -Infinity) {
			return 0;
		}

		return Math.pow(10, volumeDb / 20);
	}
}
