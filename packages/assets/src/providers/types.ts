/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The asset acquisition boundary: what an internet provider offers, what a
// search asks, and what a candidate carries. Providers normalize their
// wire shape into AssetCandidate; everything downstream (preview, import,
// provenance) only ever sees candidates.

/** The media kinds a provider can return. `gif` is animated; a still GIF is an image. */
export type AssetKind = 'image' | 'video' | 'gif' | 'audio';

/** What a provider supports, so search can skip providers that cannot answer. */
export interface ProviderCapabilities {
	kinds: AssetKind[];
	/** Whether the provider filters by license server-side. */
	licenseFilter: boolean;
	/** Whether the provider filters image orientation server-side. */
	orientationFilter: boolean;
	/** Whether the provider offers a safe-search mode. */
	safeSearch: boolean;
	/** True when the provider needs a user-supplied API key. */
	needsKey: boolean;
	/** The environment variable the key is read from, when `needsKey`. */
	keyEnv?: string;
}

/**
 * A candidate's license, as the provider states it. `unknown` means the
 * provider said nothing usable — never a guess. `restricted` means the
 * provider's own terms govern reuse (e.g. Tenor): importable, but the
 * agent must tell the user reuse is limited.
 */
export interface AssetLicense {
	id: string;
	name: string;
	url?: string;
}

export interface AssetImageRef {
	url: string;
	width?: number;
	height?: number;
}

export interface AssetDownload extends AssetImageRef {
	mimeType?: string;
	/** Seconds, for video/audio. */
	duration?: number;
	/** Bytes, when the provider states it. */
	size?: number;
}

/**
 * One normalized search hit. Everything an agent needs to choose, and
 * everything import needs to fetch: the download URL plus the provenance
 * that will be stored with the local copy.
 */
export interface AssetCandidate {
	/** Provider id (`wikimedia`, `openverse`, `pexels`, `tenor`, `url`). */
	provider: string;
	/** The provider-native id (page id, result id, or the URL for `url`). */
	remoteId: string;
	kind: AssetKind;
	title: string;
	description?: string;
	author?: string;
	authorUrl?: string;
	license: AssetLicense;
	/** The provider's landing page for attribution and click-through. */
	sourcePageUrl?: string;
	thumbnail: AssetImageRef;
	/** The file import fetches. For GIFs this is the mp4 rendition when the provider offers one. */
	download: AssetDownload;
	/** Other renditions (original GIF, other sizes) the agent may prefer. */
	alternates?: { label: string; url: string; mimeType?: string; width?: number; height?: number }[];
	width?: number;
	height?: number;
	/** Seconds, for video/audio. */
	duration?: number;
}

export interface AssetSearchQuery {
	query: string;
	kinds?: AssetKind[];
	orientation?: 'landscape' | 'portrait' | 'square';
	/**
	 * License posture. `reusable` (the default) restricts to commercially
	 * usable, modifiable works where the provider can express that;
	 * `any` takes whatever the provider returns; any other value is
	 * passed to providers that accept raw license slugs.
	 */
	license?: 'reusable' | 'any' | string;
	/** Prefer safe-search filtering where the provider offers it. Default true. */
	safe?: boolean;
	page?: number;
	perPage?: number;
}

export interface AssetSearchResult {
	candidates: AssetCandidate[];
	page: number;
	perPage: number;
	total?: number;
}

/** What a provider may use during search: JSON over HTTP plus its key. */
export interface ProviderContext {
	/** GET JSON, provider APIs only (imported bytes go through the secure downloader). */
	fetchJson(url: string, init?: { headers?: Record<string, string> }): Promise<{ status: number; body: unknown; retryAfter?: number }>;
	/** Contact string sent as User-Agent where the provider requires one. */
	userAgent: string;
	/** API keys by provider id, absent when unconfigured. */
	keys: Record<string, string | undefined>;
}

export interface AssetSearchProvider {
	id: string;
	label: string;
	capabilities: ProviderCapabilities;
	/** False when the provider needs a key that is not configured. */
	available(keys: Record<string, string | undefined>): boolean;
	search(query: AssetSearchQuery, ctx: ProviderContext): Promise<AssetSearchResult>;
}

/** Attribution text for a candidate, for the agent to show or store. Empty when nothing is known. */
export function candidateAttribution(candidate: AssetCandidate): string {
	const parts: string[] = [];
	if (candidate.title) parts.push(`"${candidate.title}"`);
	if (candidate.author) parts.push(`by ${candidate.author}`);
	if (candidate.license.id !== 'unknown') parts.push(candidate.license.name);
	if (candidate.sourcePageUrl) parts.push(candidate.sourcePageUrl);
	return parts.join(' ');
}
