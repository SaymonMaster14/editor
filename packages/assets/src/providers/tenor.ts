/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tenor v2 search: the GIF catalog, behind a user-supplied API key from the
// Google Cloud Console. Two honest caveats ride on every candidate: Tenor
// GIFs are NOT freely licensed (Tenor's own terms govern reuse), and the
// download is the mp4 rendition — the playback-friendly form — with the
// original GIF kept as an alternate.

import type {
	AssetCandidate,
	AssetSearchProvider,
	ProviderContext,
} from './types';

const SEARCH = 'https://tenor.googleapis.com/v2/search';

const TENOR_LICENSE = {
	id: 'restricted',
	name: 'Tenor Terms of Service (not freely licensed)',
	url: 'https://tenor.com/legal-terms',
};

interface TenorFormat {
	url?: string;
	dims?: [number, number];
	size?: number;
}

interface TenorResult {
	id: string;
	title?: string;
	content_description?: string;
	itemurl?: string;
	tags?: string[];
	media_formats?: Record<string, TenorFormat | undefined>;
}

function tenorToCandidate(hit: TenorResult): AssetCandidate | null {
	const formats = hit.media_formats ?? {};
	const mp4 = formats.mp4 ?? formats.loopedmp4;
	const gif = formats.gif ?? formats.mediumgif;
	const tiny = formats.tinygif ?? formats.nanogif;
	const primary = mp4?.url ? { format: mp4, mimeType: 'video/mp4' } : gif?.url ? { format: gif, mimeType: 'image/gif' } : null;
	if (!primary?.format.url) return null;
	const [width, height] = primary.format.dims ?? [];
	return {
		provider: 'tenor',
		remoteId: hit.id,
		kind: 'gif',
		title: hit.title || hit.content_description || `Tenor GIF ${hit.id}`,
		description: (hit.tags ?? []).slice(0, 8).join(', ') || undefined,
		license: { ...TENOR_LICENSE },
		sourcePageUrl: hit.itemurl || undefined,
		thumbnail: tiny?.url ? { url: tiny.url, width: tiny.dims?.[0], height: tiny.dims?.[1] } : { url: primary.format.url },
		download: {
			url: primary.format.url,
			mimeType: primary.mimeType,
			width,
			height,
			size: primary.format.size,
		},
		alternates:
			gif?.url && gif.url !== primary.format.url
				? [{ label: 'original gif', url: gif.url, mimeType: 'image/gif', width: gif.dims?.[0], height: gif.dims?.[1] }]
				: undefined,
		width,
		height,
	};
}

export const tenorProvider: AssetSearchProvider = {
	id: 'tenor',
	label: 'Tenor',
	capabilities: {
		kinds: ['gif'],
		licenseFilter: false,
		orientationFilter: false,
		safeSearch: true,
		needsKey: true,
		keyEnv: 'TENOR_API_KEY',
	},
	available: (keys) => !!keys.tenor,

	async search(query, ctx: ProviderContext) {
		const key = ctx.keys.tenor;
		if (!key) throw new Error('Tenor needs an API key (TENOR_API_KEY).');
		const params = new URLSearchParams({
			q: query.query,
			key,
			client_key: 'diffusion-studio',
			limit: String(Math.min(Math.max(query.perPage ?? 10, 1), 50)),
			media_filter: 'gif,mp4,tinygif',
			contentfilter: query.safe === false ? 'medium' : 'high',
		});
		if (query.orientation === 'landscape') params.set('ar_range', 'wide');
		else if (query.orientation) params.set('ar_range', 'standard');
		const { status, body } = await ctx.fetchJson(`${SEARCH}?${params}`);
		if (status === 401 || status === 403) throw new Error('Tenor rejected the API key.');
		if (status === 429) throw new Error('Tenor rate-limited the search; try again shortly.');
		if (status < 200 || status >= 300) throw new Error(`Tenor search failed (HTTP ${status}).`);
		const results = (body as { results?: TenorResult[] }).results ?? [];
		const candidates: AssetCandidate[] = [];
		for (const hit of results) {
			const candidate = tenorToCandidate(hit);
			if (candidate) candidates.push(candidate);
		}
		return { candidates, page: 1, perPage: candidates.length };
	},
};
