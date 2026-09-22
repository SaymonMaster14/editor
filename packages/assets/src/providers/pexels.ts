/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Pexels search: free-to-use stock photos and videos behind a user-supplied
// API key (Authorization header). Everything carries the Pexels License —
// free for commercial use, no attribution required — recorded as such on
// every candidate. No GIF endpoint; GIF searches skip this provider.

import type {
	AssetCandidate,
	AssetSearchProvider,
	ProviderContext,
} from './types';

const PHOTOS = 'https://api.pexels.com/v1/search';
const VIDEOS = 'https://api.pexels.com/videos/search';

const PEXELS_LICENSE = {
	id: 'pexels',
	name: 'Pexels License',
	url: 'https://www.pexels.com/license/',
};

interface PexelsPhoto {
	id: number;
	width: number;
	height: number;
	url?: string;
	photographer?: string;
	photographer_url?: string;
	alt?: string;
	src?: Record<string, string | undefined>;
}

interface PexelsVideoFile {
	link?: string;
	quality?: string;
	file_type?: string;
	width?: number;
	height?: number;
}

interface PexelsVideo {
	id: number;
	width: number;
	height: number;
	duration?: number;
	url?: string;
	user?: { name?: string; url?: string };
	video_files?: PexelsVideoFile[];
	video_pictures?: { picture?: string }[];
}

function photoToCandidate(photo: PexelsPhoto): AssetCandidate | null {
	const src = photo.src ?? {};
	const url = src.large2x ?? src.large ?? src.original ?? src.medium ?? src.small;
	if (!url) return null;
	return {
		provider: 'pexels',
		remoteId: String(photo.id),
		kind: 'image',
		title: photo.alt || `Pexels photo ${photo.id}`,
		author: photo.photographer || undefined,
		authorUrl: photo.photographer_url || undefined,
		license: { ...PEXELS_LICENSE },
		sourcePageUrl: photo.url || undefined,
		thumbnail: { url: src.small ?? src.tiny ?? url },
		download: { url, width: photo.width, height: photo.height },
		alternates: src.original && src.original !== url
			? [{ label: 'original', url: src.original, width: photo.width, height: photo.height }]
			: undefined,
		width: photo.width,
		height: photo.height,
	};
}

function videoToCandidate(video: PexelsVideo): AssetCandidate | null {
	const files = (video.video_files ?? []).filter((file) => file.link && (file.file_type ?? '').startsWith('video/'));
	if (files.length === 0) return null;
	// The best mp4 at or under 1080p: full quality for the timeline without
	// a multi-hundred-megabyte original nobody asked for.
	const mp4s = files.filter((file) => (file.file_type ?? '').includes('mp4'));
	const pool = mp4s.length > 0 ? mp4s : files;
	const under = pool.filter((file) => (file.height ?? 0) <= 1080);
	const pick = [...(under.length > 0 ? under : pool)].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]!;
	const thumb = video.video_pictures?.[0]?.picture;
	return {
		provider: 'pexels',
		remoteId: String(video.id),
		kind: 'video',
		title: `Pexels video ${video.id}`,
		author: video.user?.name || undefined,
		authorUrl: video.user?.url || undefined,
		license: { ...PEXELS_LICENSE },
		sourcePageUrl: video.url || undefined,
		thumbnail: thumb ? { url: thumb } : { url: pick.link! },
		download: { url: pick.link!, mimeType: pick.file_type, width: pick.width, height: pick.height, duration: video.duration },
		alternates: files
			.filter((file) => file.link !== pick.link)
			.slice(0, 4)
			.map((file) => ({ label: `${file.quality ?? 'file'}${file.height ? ` ${file.height}p` : ''}`, url: file.link!, mimeType: file.file_type, width: file.width, height: file.height })),
		width: video.width,
		height: video.height,
		duration: video.duration,
	};
}

export const pexelsProvider: AssetSearchProvider = {
	id: 'pexels',
	label: 'Pexels',
	capabilities: {
		kinds: ['image', 'video'],
		licenseFilter: false,
		orientationFilter: true,
		safeSearch: false,
		needsKey: true,
		keyEnv: 'PEXELS_API_KEY',
	},
	available: (keys) => !!keys.pexels,

	async search(query, ctx: ProviderContext) {
		const key = ctx.keys.pexels;
		if (!key) throw new Error('Pexels needs an API key (PEXELS_API_KEY).');
		const kinds = new Set(query.kinds && query.kinds.length > 0 ? query.kinds : ['image' as const]);
		const candidates: AssetCandidate[] = [];
		const page = Math.max(query.page ?? 1, 1);
		const perPage = Math.min(Math.max(query.perPage ?? 10, 1), 80);
		const headers = { Authorization: key };
		const orientation = query.orientation;

		if (kinds.has('image')) {
			const params = new URLSearchParams({
				query: query.query,
				page: String(page),
				per_page: String(perPage),
			});
			if (orientation) params.set('orientation', orientation);
			const { status, body } = await ctx.fetchJson(`${PHOTOS}?${params}`, { headers });
			if (status === 401 || status === 403) throw new Error('Pexels rejected the API key.');
			if (status === 429) throw new Error('Pexels rate-limited the search; try again shortly.');
			if (status < 200 || status >= 300) throw new Error(`Pexels photo search failed (HTTP ${status}).`);
			for (const photo of ((body as { photos?: PexelsPhoto[] }).photos ?? [])) {
				const candidate = photoToCandidate(photo);
				if (candidate) candidates.push(candidate);
			}
		}

		if (kinds.has('video')) {
			const params = new URLSearchParams({
				query: query.query,
				page: String(page),
				per_page: String(Math.min(perPage, 20)),
			});
			if (orientation) params.set('orientation', orientation);
			const { status, body } = await ctx.fetchJson(`${VIDEOS}?${params}`, { headers });
			if (status === 401 || status === 403) throw new Error('Pexels rejected the API key.');
			if (status === 429) throw new Error('Pexels rate-limited the search; try again shortly.');
			if (status < 200 || status >= 300) throw new Error(`Pexels video search failed (HTTP ${status}).`);
			for (const video of ((body as { videos?: PexelsVideo[] }).videos ?? [])) {
				const candidate = videoToCandidate(video);
				if (candidate) candidates.push(candidate);
			}
		}

		return { candidates, page, perPage };
	},
};
