/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Wikimedia Commons search over the MediaWiki API: no key, reliably
// licensed (every file carries machine-readable license metadata), images
// plus GIFs, audio and video. Terms require a descriptive User-Agent,
// which the search context carries.

import type {
	AssetCandidate,
	AssetKind,
	AssetLicense,
	AssetSearchProvider,
	AssetSearchQuery,
	ProviderContext,
} from './types';

const API = 'https://commons.wikimedia.org/w/api.php';

/** License short names to their canonical deed URLs; anything else keeps its name with no URL. */
const LICENSE_URLS: Record<string, string> = {
	'cc0': 'https://creativecommons.org/publicdomain/zero/1.0/',
	'cc by-sa 4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
	'cc by 4.0': 'https://creativecommons.org/licenses/by/4.0/',
	'cc by-sa 3.0': 'https://creativecommons.org/licenses/by-sa/3.0/',
	'cc by 3.0': 'https://creativecommons.org/licenses/by/3.0/',
	'cc by-sa 2.5': 'https://creativecommons.org/licenses/by-sa/2.5/',
	'cc by 2.5': 'https://creativecommons.org/licenses/by/2.5/',
	'cc by-sa 2.0': 'https://creativecommons.org/licenses/by-sa/2.0/',
	'cc by 2.0': 'https://creativecommons.org/licenses/by/2.0/',
	'cc by-sa 1.0': 'https://creativecommons.org/licenses/by-sa/1.0/',
	'cc by 1.0': 'https://creativecommons.org/licenses/by/1.0/',
	'public domain': 'https://en.wikipedia.org/wiki/Public_domain',
};

function stripHtml(value: string): string {
	return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
}

function licenseOf(shortName: string | undefined): AssetLicense {
	const name = shortName ? stripHtml(shortName) : '';
	if (!name) return { id: 'unknown', name: 'unknown' };
	const url = LICENSE_URLS[name.toLowerCase()];
	return url ? { id: name.toLowerCase().replace(/\s+/g, '-'), name, url } : { id: 'other', name };
}

function kindOf(mime: string): AssetKind {
	if (mime === 'image/gif') return 'gif';
	if (mime.startsWith('image/')) return 'image';
	if (mime.startsWith('video/')) return 'video';
	if (mime.startsWith('audio/')) return 'audio';
	return 'image';
}

interface CommonsPage {
	pageid: number;
	title: string;
	imageinfo?: {
		url?: string;
		size?: number;
		width?: number;
		height?: number;
		mime?: string;
		thumburl?: string;
		thumbwidth?: number;
		thumbheight?: number;
		extmetadata?: Record<string, { value?: string } | undefined>;
	}[];
}

function toCandidate(page: CommonsPage): AssetCandidate | null {
	const info = page.imageinfo?.[0];
	if (!info?.url || !info.mime) return null;
	const meta = info.extmetadata ?? {};
	const license = licenseOf(meta.LicenseShortName?.value);
	const kind = kindOf(info.mime);
	const title = page.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
	return {
		provider: 'wikimedia',
		remoteId: String(page.pageid),
		kind,
		title,
		description: meta.ImageDescription ? stripHtml(meta.ImageDescription.value ?? '').slice(0, 280) : undefined,
		author: meta.Artist ? stripHtml(meta.Artist.value ?? '') || undefined : undefined,
		license,
		sourcePageUrl: `https://commons.wikimedia.org/?curid=${page.pageid}`,
		thumbnail: info.thumburl
			? { url: info.thumburl, width: info.thumbwidth, height: info.thumbheight }
			: { url: info.url },
		download: {
			url: info.url,
			mimeType: info.mime,
			width: info.width,
			height: info.height,
			size: info.size,
		},
		width: info.width,
		height: info.height,
	};
}

function filetypeFilter(kinds: AssetKind[] | undefined): string {
	if (!kinds || kinds.length === 0) return '';
	const wants = new Set(kinds);
	// Commons filetype: bitmap (photo-style rasters incl. GIF), drawing
	// (SVG etc.), audio, video. GIF-only cannot be expressed, so gif
	// searches take bitmaps and filter client-side.
	if (wants.has('audio') && wants.size === 1) return ' filetype:audio';
	if (wants.has('video') && wants.size === 1) return ' filetype:video';
	if (!wants.has('audio') && !wants.has('video')) return ' filetype:bitmap|drawing';
	return '';
}

function orientationOk(width: number | undefined, height: number | undefined, orientation: AssetSearchQuery['orientation']): boolean {
	if (!orientation || !width || !height) return true;
	if (orientation === 'landscape') return width > height;
	if (orientation === 'portrait') return height > width;
	return Math.abs(width - height) / Math.max(width, height) < 0.05;
}

export const wikimediaProvider: AssetSearchProvider = {
	id: 'wikimedia',
	label: 'Wikimedia Commons',
	capabilities: {
		kinds: ['image', 'video', 'gif', 'audio'],
		licenseFilter: false,
		orientationFilter: false,
		safeSearch: false,
		needsKey: false,
	},
	available: () => true,

	async search(query, ctx: ProviderContext) {
		const perPage = Math.min(Math.max(query.perPage ?? 10, 1), 50);
		const params = new URLSearchParams({
			action: 'query',
			format: 'json',
			generator: 'search',
			gsrsearch: `${query.query}${filetypeFilter(query.kinds)}`,
			gsrnamespace: '6',
			gsrlimit: String(perPage),
			gsroffset: String((Math.max(query.page ?? 1, 1) - 1) * perPage),
			prop: 'imageinfo',
			iiprop: 'url|size|mime|extmetadata',
			iiurlwidth: '320',
			origin: '*',
		});
		const { status, body } = await ctx.fetchJson(`${API}?${params}`, {
			headers: { 'User-Agent': ctx.userAgent },
		});
		if (status === 429) throw new Error('Wikimedia Commons rate-limited the search; try again shortly.');
		if (status < 200 || status >= 300) throw new Error(`Wikimedia Commons search failed (HTTP ${status}).`);
		const pages = (body as { query?: { pages?: Record<string, CommonsPage> } }).query?.pages ?? {};
		const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null;
		const candidates: AssetCandidate[] = [];
		for (const page of Object.values(pages)) {
			const candidate = toCandidate(page);
			if (!candidate) continue;
			if (kinds && !kinds.has(candidate.kind)) continue;
			if (!orientationOk(candidate.width, candidate.height, query.orientation)) continue;
			candidates.push(candidate);
		}
		return { candidates, page: Math.max(query.page ?? 1, 1), perPage };
	},
};
