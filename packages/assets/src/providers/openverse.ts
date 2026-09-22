/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Openverse search (api.openverse.org): Creative Commons' openly-licensed
// catalog, no key for anonymous use (tight daily/hourly budgets, so small
// pages and no retry storms). Images plus audio (SFX/music discovery);
// no video. Anonymous pagination hard-caps well below deep paging.

import type {
	AssetCandidate,
	AssetKind,
	AssetLicense,
	AssetSearchProvider,
	AssetSearchQuery,
	ProviderContext,
} from './types';

const IMAGES = 'https://api.openverse.org/v1/images/';
const AUDIO = 'https://api.openverse.org/v1/audio/';

function licenseOf(slug: string | undefined, version: string | undefined, url: string | undefined): AssetLicense {
	if (!slug) return { id: 'unknown', name: 'unknown' };
	const name = `CC ${slug.toUpperCase()}${version ? ` ${version}` : ''}`;
	return { id: `cc-${slug}${version ? `-${version}` : ''}`, name, url };
}

function aspectRatio(orientation: AssetSearchQuery['orientation']): string | undefined {
	if (orientation === 'landscape') return 'wide';
	if (orientation === 'portrait') return 'tall';
	if (orientation === 'square') return 'square';
	return undefined;
}

interface OpenverseImage {
	id: string;
	title?: string;
	creator?: string;
	creator_url?: string;
	url?: string;
	foreign_landing_url?: string;
	license?: string;
	license_version?: string;
	license_url?: string;
	width?: number;
	height?: number;
	thumbnail?: string;
}

interface OpenverseAudio {
	id: string;
	title?: string;
	creator?: string;
	creator_url?: string;
	url?: string;
	foreign_landing_url?: string;
	license?: string;
	license_version?: string;
	license_url?: string;
	duration?: number;
	thumbnail?: string;
}

function imageToCandidate(hit: OpenverseImage): AssetCandidate | null {
	if (!hit.url) return null;
	const kind: AssetKind = /\.gif(\?|$)/i.test(hit.url) ? 'gif' : 'image';
	return {
		provider: 'openverse',
		remoteId: hit.id,
		kind,
		title: hit.title || 'Untitled',
		author: hit.creator || undefined,
		authorUrl: hit.creator_url || undefined,
		license: licenseOf(hit.license, hit.license_version, hit.license_url),
		sourcePageUrl: hit.foreign_landing_url || undefined,
		thumbnail: hit.thumbnail ? { url: hit.thumbnail } : { url: hit.url },
		download: { url: hit.url, width: hit.width, height: hit.height },
		width: hit.width,
		height: hit.height,
	};
}

function audioToCandidate(hit: OpenverseAudio): AssetCandidate | null {
	if (!hit.url) return null;
	return {
		provider: 'openverse',
		remoteId: hit.id,
		kind: 'audio',
		title: hit.title || 'Untitled',
		author: hit.creator || undefined,
		authorUrl: hit.creator_url || undefined,
		license: licenseOf(hit.license, hit.license_version, hit.license_url),
		sourcePageUrl: hit.foreign_landing_url || undefined,
		thumbnail: hit.thumbnail ? { url: hit.thumbnail } : { url: hit.url },
		download: { url: hit.url },
	};
}

export const openverseProvider: AssetSearchProvider = {
	id: 'openverse',
	label: 'Openverse',
	capabilities: {
		kinds: ['image', 'gif', 'audio'],
		licenseFilter: true,
		orientationFilter: true,
		safeSearch: false,
		needsKey: false,
	},
	available: () => true,

	async search(query, ctx: ProviderContext) {
		const kinds = new Set(query.kinds && query.kinds.length > 0 ? query.kinds : ['image' as AssetKind]);
		const candidates: AssetCandidate[] = [];
		const page = Math.max(query.page ?? 1, 1);
		// Anonymous budgets are small; keep pages modest whatever the caller asks.
		const perPage = Math.min(Math.max(query.perPage ?? 10, 1), 20);
		const license = query.license ?? 'reusable';
		const licenseType = license === 'any' ? undefined : 'commercial,modification';

		if (kinds.has('image') || kinds.has('gif')) {
			const params = new URLSearchParams({
				q: query.query,
				page: String(page),
				page_size: String(perPage),
			});
			if (licenseType) params.set('license_type', licenseType);
			else if (license !== 'reusable') params.set('license', license);
			const aspect = aspectRatio(query.orientation);
			if (aspect) params.set('aspect_ratio', aspect);
			if (!kinds.has('image')) params.set('extension', 'gif');
			const result = await get<OpenverseImage>(`${IMAGES}?${params}`, ctx);
			for (const hit of result) {
				const candidate = imageToCandidate(hit);
				if (candidate && kinds.has(candidate.kind)) candidates.push(candidate);
			}
		}

		if (kinds.has('audio')) {
			const params = new URLSearchParams({
				q: query.query,
				page: String(page),
				page_size: String(perPage),
			});
			if (licenseType) params.set('license_type', licenseType);
			else if (license !== 'reusable') params.set('license', license);
			const result = await get<OpenverseAudio>(`${AUDIO}?${params}`, ctx);
			for (const hit of result) {
				const candidate = audioToCandidate(hit);
				if (candidate) candidates.push(candidate);
			}
		}

		return { candidates, page, perPage };
	},
};

async function get<T>(url: string, ctx: ProviderContext): Promise<T[]> {
	const { status, body, retryAfter } = await ctx.fetchJson(url, {
		headers: { 'User-Agent': ctx.userAgent },
	});
	if (status === 429) {
		throw new Error(
			`Openverse rate-limited anonymous search${retryAfter ? ` (retry after ${retryAfter}s)` : ''}; narrow the query or wait.`,
		);
	}
	if (status < 200 || status >= 300) throw new Error(`Openverse search failed (HTTP ${status}).`);
	const results = (body as { results?: T[] }).results;
	return Array.isArray(results) ? results : [];
}
