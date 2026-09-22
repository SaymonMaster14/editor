/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Provenance: where an imported asset came from, stored with the asset so
// the project stays attributable and reproducible offline. The manifest
// persists every own property it does not recognize, so a provenance
// object on the asset round-trips with no manifest changes.

import type { AssetCandidate } from './providers/types';

/** Where an asset came from. Unknown stays unknown — never guessed. */
export interface AssetProvenance {
	/** Provider id, or `url` for a direct URL import, `local` for a user file. */
	provider: string;
	/** The search query that surfaced the asset, when there was one. */
	query?: string;
	/** The exact file URL that was fetched. */
	sourceUrl: string;
	/** Where the bytes came from after redirects, when different. */
	finalUrl?: string;
	/** The provider's landing page for attribution. */
	assetPageUrl?: string;
	author?: string;
	authorUrl?: string;
	license?: string;
	licenseUrl?: string;
	/** ISO timestamp of the import. */
	retrievedAt: string;
	/** SHA-256 of the stored bytes, hex. */
	sha256: string;
	/** The provider-native id, for re-resolution and debugging. */
	remoteId?: string;
	/** Rendition note, e.g. which alternate of a GIF was imported. */
	rendition?: string;
}

/** Build provenance for a candidate import; the caller fills `sha256` after hashing the bytes. */
export function provenanceForCandidate(
	candidate: AssetCandidate,
	source: { query?: string; sourceUrl: string; finalUrl?: string; rendition?: string; sha256: string; retrievedAt?: Date },
): AssetProvenance {
	return {
		provider: candidate.provider,
		query: source.query,
		sourceUrl: source.sourceUrl,
		finalUrl: source.finalUrl === source.sourceUrl ? undefined : source.finalUrl,
		assetPageUrl: candidate.sourcePageUrl,
		author: candidate.author,
		authorUrl: candidate.authorUrl,
		license: candidate.license.id === 'unknown' ? 'unknown' : candidate.license.name,
		licenseUrl: candidate.license.url,
		retrievedAt: (source.retrievedAt ?? new Date()).toISOString(),
		sha256: source.sha256,
		remoteId: candidate.remoteId,
		rendition: source.rendition,
	};
}

/** Build provenance for a direct URL import, where nothing is known but the URL. */
export function provenanceForUrl(source: { sourceUrl: string; finalUrl?: string; sha256: string; retrievedAt?: Date }): AssetProvenance {
	return {
		provider: 'url',
		sourceUrl: source.sourceUrl,
		finalUrl: source.finalUrl === source.sourceUrl ? undefined : source.finalUrl,
		license: 'unknown',
		retrievedAt: (source.retrievedAt ?? new Date()).toISOString(),
		sha256: source.sha256,
	};
}

/** One-line attribution for an imported asset, for display and export records. */
export function provenanceAttribution(provenance: AssetProvenance): string {
	const parts: string[] = [];
	if (provenance.author) parts.push(`by ${provenance.author}`);
	if (provenance.license && provenance.license !== 'unknown') parts.push(provenance.license);
	if (provenance.assetPageUrl) parts.push(provenance.assetPageUrl);
	const tail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
	return `via ${provenance.provider}${tail}`;
}
