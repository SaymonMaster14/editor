/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { candidateAttribution } from './types';
import { getProvider, listProviders, registerProvider, searchProviders, unregisterProvider } from './registry';

import type { Mock } from 'vitest';
import type { ProviderContext } from './types';

type FetchJsonMock = Mock<ProviderContext['fetchJson']>;

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext & { fetchJson: FetchJsonMock } {
	const fetchJson = vi.fn(async () => ({ status: 200, body: {} })) as unknown as FetchJsonMock;
	return { userAgent: 'test-agent', keys: {}, ...overrides, fetchJson };
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe('registry', () => {
	it('ships the four built-in providers', () => {
		expect(listProviders().map((provider) => provider.id).sort()).toEqual(['openverse', 'pexels', 'tenor', 'wikimedia']);
		expect(getProvider('nope')).toBeNull();
	});

	it('rejects duplicate registration', () => {
		expect(() => registerProvider(getProvider('wikimedia')!)).toThrow(/already registered/);
	});

	it('skips keyed providers without keys, and reports unknown ids', async () => {
		const context = ctx();
		const { candidates, outcomes } = await searchProviders(['pexels', 'tenor', 'bogus'], { query: 'cat' }, context);
		expect(candidates).toEqual([]);
		expect(context.fetchJson).not.toHaveBeenCalled();
		expect(outcomes.map((outcome) => outcome.error)).toEqual([
			'Provider "pexels" needs a key (PEXELS_API_KEY).',
			'Provider "tenor" needs a key (TENOR_API_KEY).',
			'Unknown provider "bogus".',
		]);
	});

	it('skips providers that serve none of the requested kinds', async () => {
		const context = ctx();
		const { outcomes } = await searchProviders(['tenor'], { query: 'cat', kinds: ['video'] }, context);
		expect(outcomes[0]!.error).toMatch(/none of: video/);
		expect(context.fetchJson).not.toHaveBeenCalled();
	});

	it('keeps one provider failure from failing the search', async () => {
		registerProvider({
			id: 'boom',
			label: 'Boom',
			capabilities: { kinds: ['image'], licenseFilter: false, orientationFilter: false, safeSearch: false, needsKey: false },
			available: () => true,
			search: async () => {
				throw new Error('kaput');
			},
		});
		try {
			const context = ctx();
			context.fetchJson.mockResolvedValueOnce({ status: 200, body: { query: { pages: {} } } });
			const { candidates, outcomes } = await searchProviders(['boom', 'wikimedia'], { query: 'cat' }, context);
			expect(candidates).toEqual([]);
			expect(outcomes).toEqual([
				{ provider: 'boom', result: null, error: 'kaput' },
				{ provider: 'wikimedia', result: { candidates: [], page: 1, perPage: 10 }, error: null },
			]);
		} finally {
			unregisterProvider('boom');
		}
	});
});

describe('wikimedia', () => {
	const page = {
		pageid: 123,
		title: 'File:CRT monitor.jpg',
		imageinfo: [
			{
				url: 'https://upload.wikimedia.org/wikipedia/commons/1/2/CRT_monitor.jpg',
				size: 4242,
				width: 800,
				height: 600,
				mime: 'image/jpeg',
				thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/2/CRT_monitor.jpg/320px-CRT_monitor.jpg',
				thumbwidth: 320,
				thumbheight: 240,
				extmetadata: {
					LicenseShortName: { value: 'CC BY-SA 4.0' },
					Artist: { value: '<a href="https://example.invalid">Jane</a>' },
					ImageDescription: { value: 'A <b>CRT</b> monitor.' },
				},
			},
		],
	};

	it('normalizes a file page into a candidate', async () => {
		const context = ctx();
		context.fetchJson.mockResolvedValueOnce({ status: 200, body: { query: { pages: { 123: page } } } });
		const { candidates } = await getProvider('wikimedia')!.search({ query: 'crt monitor' }, context);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			provider: 'wikimedia',
			remoteId: '123',
			kind: 'image',
			title: 'CRT monitor',
			author: 'Jane',
			license: { id: 'cc-by-sa-4.0', name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
			sourcePageUrl: 'https://commons.wikimedia.org/?curid=123',
			width: 800,
			height: 600,
		});
		expect(candidates[0]!.download.url).toContain('upload.wikimedia.org');
		expect(candidates[0]!.thumbnail.url).toContain('320px');
	});

	it('marks missing licenses unknown and keeps unmapped names without URLs', async () => {
		const context = ctx();
		const noLicense = structuredClone(page);
		delete (noLicense.imageinfo![0]!.extmetadata as Record<string, unknown>).LicenseShortName;
		context.fetchJson.mockResolvedValueOnce({ status: 200, body: { query: { pages: { 123: noLicense } } } });
		const first = (await getProvider('wikimedia')!.search({ query: 'x' }, context)).candidates[0]!;
		expect(first.license).toEqual({ id: 'unknown', name: 'unknown' });

		const odd = structuredClone(page);
		odd.imageinfo![0]!.extmetadata!.LicenseShortName = { value: 'Some Custom Grant' };
		context.fetchJson.mockResolvedValueOnce({ status: 200, body: { query: { pages: { 123: odd } } } });
		const second = (await getProvider('wikimedia')!.search({ query: 'x' }, context)).candidates[0]!;
		expect(second.license).toEqual({ id: 'other', name: 'Some Custom Grant' });
	});

	it('detects GIFs and filters GIF-only searches client-side', async () => {
		const context = ctx();
		const gif = structuredClone(page);
		gif.imageinfo![0]!.mime = 'image/gif';
		context.fetchJson.mockResolvedValueOnce({ status: 200, body: { query: { pages: { 1: page, 2: gif } } } });
		const { candidates } = await getProvider('wikimedia')!.search({ query: 'x', kinds: ['gif'] }, context);
		expect(candidates.map((candidate) => candidate.kind)).toEqual(['gif']);
	});

	it('filters orientation client-side and reports rate limits', async () => {
		const context = ctx();
		context.fetchJson.mockResolvedValueOnce({ status: 200, body: { query: { pages: { 123: page } } } });
		const portrait = await getProvider('wikimedia')!.search({ query: 'x', orientation: 'portrait' }, context);
		expect(portrait.candidates).toEqual([]);
		context.fetchJson.mockResolvedValueOnce({ status: 429, body: {} });
		await expect(getProvider('wikimedia')!.search({ query: 'x' }, context)).rejects.toThrow(/rate-limited/);
	});
});

describe('openverse', () => {
	const hit = {
		id: 'abc',
		title: 'CRT',
		creator: 'Jane',
		creator_url: 'https://example.invalid/jane',
		url: 'https://live.staticflickr.com/1/2_3.jpg',
		foreign_landing_url: 'https://flickr.com/photos/x/1',
		license: 'by',
		license_version: '2.0',
		license_url: 'https://creativecommons.org/licenses/by/2.0/',
		width: 640,
		height: 480,
		thumbnail: 'https://api.openverse.org/v1/images/abc/thumb/',
	};

	it('searches images with reusable licensing by default', async () => {
		const context = ctx();
		context.fetchJson.mockResolvedValueOnce({ status: 200, body: { results: [hit] } });
		const { candidates } = await getProvider('openverse')!.search({ query: 'crt' }, context);
		const requested = new URL(context.fetchJson.mock.calls[0]![0]);
		expect(requested.pathname).toBe('/v1/images/');
		expect(requested.searchParams.get('license_type')).toBe('commercial,modification');
		expect(candidates[0]).toMatchObject({
			provider: 'openverse',
			remoteId: 'abc',
			kind: 'image',
			author: 'Jane',
			license: { id: 'cc-by-2.0', name: 'CC BY 2.0', url: 'https://creativecommons.org/licenses/by/2.0/' },
		});
	});

	it('searches audio and surfaces 429s with retry hints', async () => {
		const context = ctx();
		context.fetchJson.mockResolvedValueOnce({ status: 200, body: { results: [{ ...hit, id: 'snd' }] } });
		const { candidates } = await getProvider('openverse')!.search({ query: 'boom', kinds: ['audio'] }, context);
		expect(new URL(context.fetchJson.mock.calls[0]![0]).pathname).toBe('/v1/audio/');
		expect(candidates[0]!.kind).toBe('audio');
		context.fetchJson.mockResolvedValueOnce({ status: 429, body: {}, retryAfter: 30 });
		await expect(getProvider('openverse')!.search({ query: 'x' }, context)).rejects.toThrow(/retry after 30s/);
	});
});

describe('pexels', () => {
	it('needs a key and normalizes photos', async () => {
		const provider = getProvider('pexels')!;
		expect(provider.available({})).toBe(false);
		expect(provider.available({ pexels: 'k' })).toBe(true);
		const context = ctx({ keys: { pexels: 'k' } });
		context.fetchJson.mockResolvedValueOnce({
			status: 200,
			body: {
				photos: [
					{
						id: 7,
						width: 100,
						height: 50,
						url: 'https://pexels.com/photo/7',
						photographer: 'Ann',
						src: { original: 'https://images.pexels.com/o.jpg', large2x: 'https://images.pexels.com/l.jpg', small: 'https://images.pexels.com/s.jpg' },
					},
				],
			},
		});
		const { candidates } = await provider.search({ query: 'typing' }, context);
		expect(context.fetchJson.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: 'k' } });
		expect(candidates[0]).toMatchObject({
			provider: 'pexels',
			kind: 'image',
			license: { id: 'pexels', name: 'Pexels License' },
			download: { url: 'https://images.pexels.com/l.jpg' },
		});
		expect(candidates[0]!.alternates?.[0]?.label).toBe('original');
	});

	it('picks the best mp4 at or under 1080p for video', async () => {
		const context = ctx({ keys: { pexels: 'k' } });
		const files = [
			{ link: 'https://v/sd.mp4', quality: 'sd', file_type: 'video/mp4', width: 640, height: 360 },
			{ link: 'https://v/hd.mp4', quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080 },
			{ link: 'https://v/uhd.mp4', quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160 },
		];
		context.fetchJson.mockResolvedValueOnce({ status: 200, body: { videos: [{ id: 9, width: 1920, height: 1080, duration: 12, video_files: files, video_pictures: [{ picture: 'https://v/t.jpg' }] }] } });
		const { candidates } = await getProvider('pexels')!.search({ query: 'typing', kinds: ['video'] }, context);
		expect(candidates[0]!.download.url).toBe('https://v/hd.mp4');
		expect(candidates[0]!.duration).toBe(12);
		context.fetchJson.mockResolvedValueOnce({ status: 401, body: {} });
		await expect(getProvider('pexels')!.search({ query: 'x' }, context)).rejects.toThrow(/rejected the API key/);
	});
});

describe('tenor', () => {
	it('needs a key and prefers the mp4 rendition', async () => {
		const provider = getProvider('tenor')!;
		expect(provider.available({})).toBe(false);
		const context = ctx({ keys: { tenor: 'k' } });
		context.fetchJson.mockResolvedValueOnce({
			status: 200,
			body: {
				results: [
					{
						id: '42',
						title: 'Boom',
						itemurl: 'https://tenor.com/view/42',
						tags: ['boom'],
						media_formats: {
							gif: { url: 'https://media.tenor.com/42.gif', dims: [200, 200], size: 999 },
							mp4: { url: 'https://media.tenor.com/42.mp4', dims: [200, 200], size: 111 },
							tinygif: { url: 'https://media.tenor.com/42tiny.gif', dims: [50, 50] },
						},
					},
				],
			},
		});
		const { candidates } = await provider.search({ query: 'explosion' }, context);
		const requested = new URL(context.fetchJson.mock.calls[0]![0]);
		expect(requested.searchParams.get('contentfilter')).toBe('high');
		expect(requested.searchParams.get('client_key')).toBe('diffusion-studio');
		expect(candidates[0]).toMatchObject({
			provider: 'tenor',
			kind: 'gif',
			download: { url: 'https://media.tenor.com/42.mp4', mimeType: 'video/mp4' },
			license: { id: 'restricted' },
		});
		expect(candidates[0]!.alternates?.[0]).toMatchObject({ label: 'original gif', url: 'https://media.tenor.com/42.gif' });
	});
});

describe('candidateAttribution', () => {
	it('composes attribution and skips unknowns', () => {
		expect(
			candidateAttribution({
				provider: 'openverse',
				remoteId: '1',
				kind: 'image',
				title: 'CRT',
				author: 'Jane',
				license: { id: 'cc-by-2.0', name: 'CC BY 2.0' },
				thumbnail: { url: 'https://example.invalid/t.jpg' },
				download: { url: 'https://example.invalid/f.jpg' },
				sourcePageUrl: 'https://example.invalid/page',
			}),
		).toBe('"CRT" by Jane CC BY 2.0 https://example.invalid/page');
	});
});
