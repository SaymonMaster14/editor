/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The provider registry: every search integration registers here, and search
// fans out across the providers that can answer. One provider failing (rate
// limit, outage, missing key) never fails the whole search — its error rides
// along next to the other providers' candidates.

import { openverseProvider } from './openverse';
import { pexelsProvider } from './pexels';
import { tenorProvider } from './tenor';
import { wikimediaProvider } from './wikimedia';

import type {
	AssetCandidate,
	AssetSearchProvider,
	AssetSearchQuery,
	AssetSearchResult,
	ProviderContext,
} from './types';

const providers = new Map<string, AssetSearchProvider>();

/** Register a provider (id must be unique); used by tests to add fakes. */
export function registerProvider(provider: AssetSearchProvider): void {
	if (providers.has(provider.id)) throw new Error(`Asset provider "${provider.id}" is already registered.`);
	providers.set(provider.id, provider);
}

/** Remove a provider; test-only. */
export function unregisterProvider(id: string): void {
	providers.delete(id);
}

/** Every registered provider. */
export function listProviders(): AssetSearchProvider[] {
	return [...providers.values()];
}

/** The provider with an id, or null. */
export function getProvider(id: string): AssetSearchProvider | null {
	return providers.get(id) ?? null;
}

export interface ProviderSearchOutcome {
	provider: string;
	result: AssetSearchResult | null;
	/** Why this provider contributed nothing (missing key, rate limit, outage). */
	error: string | null;
}

export interface MultiSearchResult {
	candidates: AssetCandidate[];
	outcomes: ProviderSearchOutcome[];
}

/**
 * Search every provider that can answer, most permissive first. `ids`
 * restricts the fan-out; unknown ids produce error outcomes rather than
 * throwing. A provider that needs a key it does not have is skipped with
 * an outcome saying which variable would enable it.
 */
export async function searchProviders(
	ids: string[] | undefined,
	query: AssetSearchQuery,
	ctx: ProviderContext,
): Promise<MultiSearchResult> {
	const wanted = ids ?? [...providers.keys()];
	const candidates: AssetCandidate[] = [];
	const outcomes: ProviderSearchOutcome[] = [];
	for (const id of wanted) {
		const provider = providers.get(id);
		if (!provider) {
			outcomes.push({ provider: id, result: null, error: `Unknown provider "${id}".` });
			continue;
		}
		if (query.kinds && !query.kinds.some((kind) => provider.capabilities.kinds.includes(kind))) {
			outcomes.push({ provider: id, result: null, error: `Provider "${id}" serves none of: ${query.kinds.join(', ')}.` });
			continue;
		}
		if (!provider.available(ctx.keys)) {
			const env = provider.capabilities.keyEnv ?? `${id.toUpperCase()}_API_KEY`;
			outcomes.push({ provider: id, result: null, error: `Provider "${id}" needs a key (${env}).` });
			continue;
		}
		try {
			const result = await provider.search(query, ctx);
			candidates.push(...result.candidates);
			outcomes.push({ provider: id, result, error: null });
		} catch (error) {
			outcomes.push({ provider: id, result: null, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { candidates, outcomes };
}

registerProvider(wikimediaProvider);
registerProvider(openverseProvider);
registerProvider(pexelsProvider);
registerProvider(tenorProvider);
