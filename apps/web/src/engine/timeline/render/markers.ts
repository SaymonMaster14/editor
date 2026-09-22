/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Markers, setPlayhead } from '@diffusionstudio/runtime';

import { markerColorHex, moveMarker, removeMarker } from '../../markers';
import { framesToPixels, getResolution, getScrollX, getViewport, pixelsToFrames } from '../view';

import type { Entity, World } from 'koota';
import type { TimelineSurfaceState } from '../surface';

/** Half the width of a flag's diamond, and of its grab region. */
const FLAG_HALF = 6;
/** Where the flag band ends: above the work area's bar and the tick labels' lower half. */
const FLAG_BAND = 22;

// A flag drag in flight: markers carry no entity to hang an origin trait on,
// so the press frame and the last committed frame are kept here. The drag is
// tracked manually rather than through the region's `dragging` — a region id
// names the frame the flag stands on, which is what the drag changes.
let drag: { origin: number; last: number } | null = null;

/**
 * The scene's markers as flags in the ruler's upper band: a diamond in the
 * flag's color. Click a flag to jump the playhead to it, drag it to move
 * it, double-click it to take it off.
 *
 * The regions register after the ruler's own, so a flag wins the press over a
 * scrub; the ruler's `dragging` stays false under a flag drag for the same
 * reason (see the pointer's top-region rule). A drag's burst of moves
 * coalesces into one undo step, the way a trim's does.
 */
export function renderMarkers(world: World, scene: Entity, surface: TimelineSurfaceState): void {
	const { ctx, pointer } = surface;
	if (!ctx || !pointer) return;
	if (!scene.has(Markers)) {
		drag = null;
		return;
	}

	const scrollX = getScrollX(world, scene);
	const resolution = getResolution(world, scene);
	const [minX, maxX] = getViewport(world, scene, surface.layout.width);

	ctx.save();
	ctx.translate(-(scrollX * resolution), 0);

	pointer.scope('markers');

	for (const marker of scene.get(Markers)!.list) {
		const x = framesToPixels(marker.at, resolution);
		if (x < minX - FLAG_HALF || x > maxX + FLAG_HALF) continue;

		const { pressed, clicked, doubleClicked } = pointer.region(
			x - FLAG_HALF, 0, FLAG_HALF * 2, FLAG_BAND, `marker-${marker.at}`,
		);

		if (pressed) drag = { origin: marker.at, last: marker.at };
		if (doubleClicked) {
			removeMarker(world, { scene, at: marker.at });
			drag = null;
		} else if (clicked) {
			setPlayhead(world, scene, marker.at);
		}

		drawFlag(ctx, x, markerColorHex(marker.color));
	}

	// The drag outlives the press frame, and the flag it moves may have left
	// the viewport — it is settled here, past the regions, rather than in the
	// loop. A refused move (another flag standing at the target) simply holds
	// the last committed frame until the pointer moves on.
	if (drag && pointer.position?.state === 'pressing') {
		const target = Math.max(0, drag.origin + pixelsToFrames(pointer.position.deltaX, resolution));
		if (target !== drag.last && moveMarker(world, { scene, from: drag.last, to: target })) {
			drag.last = target;
		}
	} else if (drag && pointer.position?.state !== 'pressing') {
		drag = null;
	}

	ctx.restore();
}

/** A flag: a diamond in its color, floating clear of the tick labels. */
function drawFlag(ctx: CanvasRenderingContext2D, x: number, color: string): void {
	ctx.save();

	ctx.fillStyle = color;
	ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
	ctx.lineWidth = 1;

	ctx.beginPath();
	ctx.moveTo(x, 2);
	ctx.lineTo(x + FLAG_HALF - 1, 8);
	ctx.lineTo(x, 14);
	ctx.lineTo(x - (FLAG_HALF - 1), 8);
	ctx.closePath();
	ctx.fill();
	ctx.stroke();

	ctx.restore();
}
