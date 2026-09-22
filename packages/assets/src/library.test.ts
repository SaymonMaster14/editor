/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { AssetLibrary } from './library';

import type { ProjectFS } from './fs';

/** In-memory host: `rewrite` swaps the bytes the way an atomic rename does. */
function memoryFs(): ProjectFS & { rewrite(source: string, text: string): void } {
	const files = new Map<string, File>();
	files.set('C:/abs/x.vtt', new File(['WEBVTT\n\n00:00.000 --> 00:01.000\none\n'], 'x.vtt'));
	return {
		readManifest: async () => null,
		writeManifest: async () => {},
		list: async () => [],
		stat: async (source) => {
			const file = files.get(source);
			return file ? { size: file.size, mtime: file.lastModified } : null;
		},
		file: async (source) => {
			const file = files.get(source);
			if (!file) throw new Error(`No such file: ${source}`);
			return file;
		},
		write: async () => {},
		remove: async () => {},
		rewrite(source, text) {
			const prev = files.get(source);
			files.set(source, new File([text], 'x.vtt', { lastModified: (prev?.lastModified ?? 0) + 1000 }));
		},
	};
}

describe('transient resolve', () => {
	it('describes an absolute path in place without adding it', async () => {
		const fs = memoryFs();
		const library = new AssetLibrary(fs);
		const asset = await library.resolve('C:/abs/x.vtt');
		expect(asset.transient).toBe(true);
		expect(asset.type).toBe('TRANSCRIPT');
		expect(asset.source).toBe('C:/abs/x.vtt');
		expect(library.list()).toHaveLength(0);
	});

	it('serves the cached transient while the file is unchanged', async () => {
		const fs = memoryFs();
		const library = new AssetLibrary(fs);
		const first = await library.resolve('C:/abs/x.vtt');
		const second = await library.resolve('C:/abs/x.vtt');
		expect(second).toBe(first);
	});

	it('describes again after the file changes under the cached transient', async () => {
		const fs = memoryFs();
		const library = new AssetLibrary(fs);
		const first = await library.resolve('C:/abs/x.vtt');
		fs.rewrite('C:/abs/x.vtt', 'WEBVTT\n\n00:00.000 --> 00:02.000\none changed\n');
		const second = await library.resolve('C:/abs/x.vtt');
		expect(second).not.toBe(first);
		expect(second.transient).toBe(true);
		expect(second.id).not.toBe(first.id);
		expect(second.stat).toEqual(await fs.stat('C:/abs/x.vtt'));
		// The stale entry is dropped, so id lookups cannot serve it either.
		expect(library.get(first.id)).toBeUndefined();
		expect(library.get(second.id)).toBe(second);
	});
});
