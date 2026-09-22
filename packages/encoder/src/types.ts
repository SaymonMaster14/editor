/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { StreamTargetChunk } from 'mediabunny';

/** Container format of the output file. */
export type ContainerFormat = 'mp4' | 'webm' | 'ogg' | 'mov';

// Minimal FileSystemFileHandle-shaped target
export interface WritableFileTarget {
	createWritable(): Promise<WritableStream<StreamTargetChunk>>;
}

export type EncoderProgress = {
	total: number;
	progress: number;
	remaining: Date;
};

/** Measured loudness of an export's rendered mix (the pre-encode PCM). */
export interface ExportAudioMeasurement {
	/** Gated integrated loudness; -Infinity when unmeasurable. */
	integratedLUFS: number;
	/** 10th–95th percentile spread of 3 s short-term loudness; null when too short. */
	loudnessRangeLU: number | null;
	/** 4x-oversampled true peak, dBTP. */
	truePeakDbTP: number;
	/** Sample peak, dBFS. */
	samplePeakDbFS: number;
	/** Mix length, seconds. */
	seconds: number;
}

export type ExportResult =
	| {
		type: 'success';
		data: Blob | undefined;
		/** Present when audio was rendered. */
		audio?: ExportAudioMeasurement;
	}
	| {
		type: 'canceled';
	}
	| {
		type: 'error';
		error: Error;
	};
