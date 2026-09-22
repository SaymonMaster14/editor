/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Editing a text node's content on the canvas. The canvas itself cannot take
 * text input, so a <textarea> is placed over the node for the duration; the
 * HUD moves it into place each frame while it is mounted. Keystrokes land
 * through the canonical `editText`, the same op the inspector's Content row
 * writes, so canvas and panel edits undo and sync as one. Enter commits,
 * Escape restores, Shift+Enter breaks the line.
 */

import { Chars, RenderSurface, TextAlign, TextStyle, Tool, ToolType } from '@diffusionstudio/runtime';

import { getDocumentEditor } from '../editor';
import { unmountNameInput } from './name-input';

import type { Entity, World } from 'koota';

const INPUT_STYLE = {
	position: 'absolute',
	transformOrigin: 'left top',
	color: 'var(--foreground)',
	background: 'color-mix(in srgb, var(--input) 82%, transparent)',
	border: '1px solid var(--primary)',
	borderRadius: '2px',
	outline: 'none',
	padding: '0',
	margin: '0',
	boxSizing: 'border-box',
	resize: 'none',
	overflow: 'hidden',
	whiteSpace: 'pre-wrap',
	zIndex: '1000',
};

let mounted: { input: HTMLTextAreaElement; entity: Entity; previousTool: ToolType } | null = null;

/** The field being edited, for the HUD to position. */
export function getMountedTextInput(): { input: HTMLTextAreaElement; entity: Entity } | null {
	return mounted;
}

/** Whether a canvas text edit is in flight. */
export function isTextInputMounted(): boolean {
	return mounted !== null;
}

/** Opens the text field over `entity`'s box. */
export function mountTextInput(world: World, entity: Entity): void {
	if (mounted) return;
	// One field at a time: a rename in flight yields to the text edit.
	unmountNameInput();
	const canvas = world.get(RenderSurface)?.canvas;
	const container = canvas instanceof HTMLCanvasElement ? canvas.parentElement : null;
	if (!container) return;

	const editor = getDocumentEditor(world);
	const original = entity.get(Chars)?.value ?? '';
	const previousTool = world.get(Tool)?.value ?? ToolType.MOVE;

	const input = document.createElement('textarea');
	input.value = original;
	input.rows = 1;
	Object.assign(input.style, INPUT_STYLE);
	// The face follows the node; the size follows it per frame with the zoom.
	const style = entity.get(TextStyle);
	if (style?.fontFamily) input.style.fontFamily = style.fontFamily;
	if (style?.fontWeight) input.style.fontWeight = style.fontWeight;
	if (style?.textAlign === TextAlign.CENTER) input.style.textAlign = 'center';
	else if (style?.textAlign === TextAlign.RIGHT) input.style.textAlign = 'right';

	input.addEventListener('input', () => {
		editor.editText(entity, input.value);
	});

	input.addEventListener('blur', () => {
		unmountTextInput(world);
	});

	input.addEventListener('keydown', (event) => {
		// The canvas shortcuts are listening on the window; typing here is not
		// for them.
		event.stopPropagation();

		if (event.key === 'Escape') {
			editor.editText(entity, original);
			unmountTextInput(world);
		}

		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			unmountTextInput(world);
		}
	});

	container.appendChild(input);
	input.focus();
	input.select();

	world.set(Tool, { value: ToolType.TEXT_EDIT });
	mounted = { input, entity, previousTool };
}

/** Closes the text field, if one is open, and gives the tool back. */
export function unmountTextInput(world?: World): void {
	if (!mounted) return;
	const { input, previousTool } = mounted;
	mounted = null;
	input.remove();
	world?.set(Tool, { value: previousTool });
}
