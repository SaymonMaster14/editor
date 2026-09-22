/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The hardened way down from the internet: every remote byte the library
// takes in — a provider file, a thumbnail, a bare URL import — passes
// through here. The fetch itself is injected, so the same guard core runs
// in the desktop main process (Node fetch, manual redirects, DNS resolved
// and checked per hop) and in a browser context (fetch follows redirects
// invisibly, so only the final URL's shape and literal address are
// checked). Two residuals are honest about themselves: a browser fetch
// cannot see intermediate redirect hops, and resolve-then-fetch has the
// usual DNS TOCTOU — a hostile name that flips its answer between the
// lookup and the connection is not caught. The threat model is an agent
// (or a provider response) pointing at internal resources, not an
// actively malicious network.

export type DownloadFailureCode =
	| 'blocked-url'
	| 'dns-blocked'
	| 'too-many-redirects'
	| 'redirect-loop'
	| 'http-error'
	| 'content-type'
	| 'too-large'
	| 'timeout'
	| 'aborted'
	| 'network-error';

export class DownloadError extends Error {
	public readonly code: DownloadFailureCode;
	public readonly url: string;
	public readonly status?: number;

	public constructor(code: DownloadFailureCode, url: string, message: string, status?: number) {
		super(message);
		this.name = 'DownloadError';
		this.code = code;
		this.url = url;
		this.status = status;
	}
}

/** Default ceiling for one download: 250 MiB covers stock clips without inviting disk bombs. */
export const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
/** Default wall clock for connect + headers + body. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Default redirect budget. */
export const DEFAULT_MAX_REDIRECTS = 5;
/** What an import may turn out to be, by content-type prefix. */
export const DEFAULT_ACCEPT = ['image/', 'video/', 'audio/'];

/** Hostnames that are loopback or instance metadata by name, not address. */
const BLOCKED_NAMES = new Set([
	'localhost',
	'metadata.google',
	'metadata.google.internal',
	'instance-data',
]);

/**
 * Parses one dotted IPv4 part the way the WHATWG URL parser reads it:
 * `0x` is hex, a leading `0` is octal, the rest decimal. Returns undefined
 * when the part is not numeric at all.
 */
function parseV4Part(part: string): number | undefined {
	if (!part) return undefined;
	let radix = 10;
	let digits = part;
	if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
		radix = 16;
		digits = part.slice(2);
	} else if (/^0[0-7]+$/.test(part)) {
		radix = 8;
	} else if (!/^[0-9]+$/.test(part)) {
		return undefined;
	}
	const value = Number.parseInt(digits, radix);
	return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Parses IPv4 in the forms hosts actually arrive in: dotted quads plus the
 * short (`127.1`), shorter (`127.0.1`), and single-integer (`2130706433`)
 * spellings, each part decimal, octal, or hex. Returns undefined unless the
 * whole string is one of those — anything else is a hostname to resolve.
 */
function parseIPv4(host: string): number | undefined {
	if (!/^[0-9a-fA-FxX.]+$/.test(host) || host.includes(':')) return undefined;
	const raw = host.split('.');
	if (raw.length > 4) return undefined;
	const parts: number[] = [];
	for (const part of raw) {
		const value = parseV4Part(part);
		if (value === undefined) return undefined;
		parts.push(value);
	}
	// Every part but the last is one octet; the last fills what remains.
	for (let i = 0; i < parts.length - 1; i++) {
		if (parts[i]! > 255) return undefined;
	}
	const widths = [0, 0, 8, 16, 24];
	const tailBits = 32 - widths[parts.length]!;
	if (parts[parts.length - 1]! >= 2 ** tailBits) return undefined;
	let value = 0;
	for (let i = 0; i < parts.length - 1; i++) value = value * 256 + parts[i]!;
	return value * 2 ** tailBits + parts[parts.length - 1]!;
}

/** v4 ranges that are never a public download source, as [first, last]. */
const BLOCKED_V4: Array<[number, number, string]> = [
	[0x00000000, 0x00ffffff, 'unspecified/reserved'],
	[0x0a000000, 0x0affffff, 'private (10/8)'],
	[0x64400000, 0x647fffff, 'carrier-grade NAT (100.64/10)'],
	[0x7f000000, 0x7fffffff, 'loopback (127/8)'],
	[0xa9fe0000, 0xa9feffff, 'link-local (169.254/16)'],
	[0xac100000, 0xac1fffff, 'private (172.16/12)'],
	[0xc0000000, 0xc00000ff, 'IETF protocol assignments (192.0.0/24)'],
	[0xc0000200, 0xc00002ff, 'documentation (192.0.2/24)'],
	[0xc0586300, 0xc05863ff, '6to4 relay (192.88.99/24)'],
	[0xc0a80000, 0xc0a8ffff, 'private (192.168/16)'],
	[0xc6120000, 0xc613ffff, 'benchmarking (198.18/15)'],
	[0xc6336400, 0xc63364ff, 'documentation (198.51.100/24)'],
	[0xcb007100, 0xcb0071ff, 'documentation (203.0.113/24)'],
	[0xe0000000, 0xefffffff, 'multicast (224/4)'],
	[0xf0000000, 0xffffffff, 'reserved (240/4)'],
];

function blockedV4Reason(value: number): string | undefined {
	for (const [first, last, reason] of BLOCKED_V4) {
		if (value >= first && value <= last) return reason;
	}
	return undefined;
}

/**
 * Classifies an IPv6 literal far enough to refuse the dangerous ranges:
 * loopback, unspecified, link-local, unique-local, multicast, and the
 * v4-mapped forms (whose embedded v4 address is judged as v4). Returns a
 * reason when blocked, null when the literal is public, undefined when the
 * string is not an IPv6 literal at all.
 */
function classifyIPv6(host: string): string | null | undefined {
	const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	if (!literal.includes(':')) return undefined;
	if (!/^[0-9a-fA-F:.]+$/.test(literal)) return undefined;
	// A dotted tail is a v4 address in v6 clothing (`::ffff:127.0.0.1`):
	// judge the v4 bytes, whatever the prefix claims.
	const dot = literal.lastIndexOf(':');
	const tail = literal.slice(dot + 1);
	if (tail.includes('.')) {
		const embedded = parseIPv4(tail);
		if (embedded === undefined) return 'unparsable IPv6 literal';
		return blockedV4Reason(embedded) ?? null;
	}
	const first = literal.split(':')[0]!;
	// `::1` and `::` start with an empty first group.
	if (first === '') {
		const compact = literal.replace(/^:+/, '');
		if (compact === '' || compact === '1') return compact === '' ? 'unspecified (::)' : 'loopback (::1)';
		return null;
	}
	const value = Number.parseInt(first, 16);
	if (!Number.isInteger(value) || value < 0 || value > 0xffff) return 'unparsable IPv6 literal';
	if (value >= 0xfe80 && value <= 0xfebf) return 'link-local (fe80::/10)';
	if (value >= 0xfc00 && value <= 0xfdff) return 'unique-local (fc00::/7)';
	if (value >= 0xff00) return 'multicast (ff00::/8)';
	return null;
}

/**
 * Refuses a hostname without touching the network: blocked literal IPs in
 * every spelling the parser accepts, plus loopback/metadata names. Returns
 * the reason, or undefined when the name is allowed to proceed to a
 * resolve-and-check (or, in a browser, to fetch).
 */
export function blockedHostReason(hostname: string): string | undefined {
	const host = hostname.trim().toLowerCase().replace(/\.$/, '');
	if (!host) return 'empty host';
	if (BLOCKED_NAMES.has(host)) return `blocked name (${host})`;
	if (host.endsWith('.localhost')) return 'loopback name (*.localhost)';
	const v4 = parseIPv4(host);
	if (v4 !== undefined) {
		const reason = blockedV4Reason(v4);
		return reason ? `blocked IPv4 literal (${reason})` : undefined;
	}
	if (host.includes(':')) {
		const v6 = classifyIPv6(host);
		if (v6 === undefined) return 'unparsable IP literal';
		return v6 === null ? undefined : `blocked IPv6 literal (${v6})`;
	}
	return undefined;
}

/** The slice of a fetch Response the downloader needs. */
export interface DownloadFetchResponse {
	status: number;
	headers: Pick<Headers, 'get'>;
	body: ReadableStream<Uint8Array> | null;
	/**
	 * Where the bytes (claim to) come from after the fetcher's own redirect
	 * handling. A manual-redirect fetcher leaves this unset and reports 3xx
	 * with Location instead; a following fetcher (browser fetch) sets it to
	 * the final URL, which the core then validates as a hop of its own.
	 */
	url?: string;
}

export interface DownloadFetchInit {
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export type DownloadFetch = (url: string, init: DownloadFetchInit) => Promise<DownloadFetchResponse>;

/**
 * Node-style fetcher: redirects come back manual (`redirect: 'manual'`),
 * so the core sees and validates every hop. Used by desktop main and the
 * CLI, where the global fetch honors the option.
 */
export const nodeDownloadFetch: DownloadFetch = async (url, init) => {
	const response = await fetch(url, { ...init, redirect: 'manual' });
	return { status: response.status, headers: response.headers, body: response.body };
};

/**
 * Browser-style fetcher: fetch follows redirects invisibly (a manual
 * redirect would surface as an opaque `status 0` with no Location), so the
 * final `response.url` is reported for the core to validate. Intermediate
 * hops are NOT seen — downloads that must prove every hop go through the
 * desktop main process instead.
 */
export const webDownloadFetch: DownloadFetch = async (url, init) => {
	const response = await fetch(url, { ...init, redirect: 'follow' });
	return { status: response.status, headers: response.headers, body: response.body, url: response.url || undefined };
};

/** Picks the fetcher for the current runtime: Node's where `process` exists, the web one elsewhere. */
export function defaultDownloadFetch(): DownloadFetch {
	const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
	return proc?.versions?.node ? nodeDownloadFetch : webDownloadFetch;
}

export interface DownloadOptions {
	/** The fetch implementation; runtime default when unset. */
	fetchImpl?: DownloadFetch;
	/**
	 * Resolves a hostname to literal IPs, every one of which must pass the
	 * blocklist (Node: `dns.promises.lookup(host, { all: true })`). Unset in
	 * browsers, which have no DNS API — there only literal-IP hosts are
	 * refused, and sensitive downloads belong in desktop main.
	 */
	resolveHost?: (host: string) => Promise<string[]>;
	/** Byte ceiling; the `content-length` header is refused early, the stream is cut mid-read. */
	maxBytes?: number;
	/** Wall clock for the whole download, redirects included. */
	timeoutMs?: number;
	/** Redirect budget. */
	maxRedirects?: number;
	/** Accepted content-type prefixes; the response must match one. */
	accept?: string[];
	/** Extra request headers (user agent, authorization). */
	headers?: Record<string, string>;
	/** Caller cancellation. */
	signal?: AbortSignal;
	/** Progress reports; `total` is the declared length when the server gives one. */
	onProgress?: (received: number, total?: number) => void;
}

export interface DownloadedBytes {
	bytes: Uint8Array;
	/** The URL the bytes actually came from, after redirects. */
	finalUrl: string;
	/** The validated content type, without parameters. */
	contentType: string;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Refuses a URL string without fetching: http(s) only, and a host the blocklist allows. */
export function validateAssetUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new DownloadError('blocked-url', url, `Not a URL: ${url}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new DownloadError('blocked-url', url, `Refused protocol ${parsed.protocol}: only http(s) may be downloaded`);
	}
	const reason = blockedHostReason(parsed.hostname);
	if (reason) throw new DownloadError('blocked-url', url, `Refused host ${parsed.hostname}: ${reason}`);
}

async function checkResolved(host: string, url: string, resolveHost: (host: string) => Promise<string[]>): Promise<void> {
	let addresses: string[];
	try {
		addresses = await resolveHost(host);
	} catch (error) {
		throw new DownloadError('network-error', url, `Could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!addresses.length) throw new DownloadError('dns-blocked', url, `${host} resolves to nothing`);
	for (const address of addresses) {
		const reason = blockedHostReason(address);
		if (reason) throw new DownloadError('dns-blocked', url, `${host} resolves to refused address ${address}: ${reason}`);
	}
}

/**
 * Runs `run` under one wall clock: the timeout and the caller's signal
 * share a controller, and the timer is always cleaned up.
 */
async function withDownloadClock<T>(
	url: string,
	timeoutMs: number,
	caller: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DownloadError('timeout', url, `Download timed out after ${timeoutMs} ms: ${url}`)), timeoutMs);
	const onCallerAbort = (): void => {
		const reason = caller?.reason;
		controller.abort(reason instanceof Error ? reason : new DownloadError('aborted', url, `Download aborted: ${url}`));
	};
	if (caller) {
		if (caller.aborted) onCallerAbort();
		else caller.addEventListener('abort', onCallerAbort, { once: true });
	}
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
		caller?.removeEventListener('abort', onCallerAbort);
	}
}

interface GuardedRoundTrip {
	fetchImpl: DownloadFetch;
	resolveHost?: (host: string) => Promise<string[]>;
	maxRedirects: number;
	headers?: Record<string, string>;
	signal: AbortSignal;
}

/**
 * One guarded round trip: every hop's scheme and host validated, DNS
 * resolved and checked when a resolver is set, redirects followed up to
 * `maxRedirects`. Returns the final response with the URL it came from.
 */
async function roundTrip(start: string, round: GuardedRoundTrip): Promise<{ response: DownloadFetchResponse; finalUrl: string }> {
	const { fetchImpl, resolveHost, maxRedirects, headers, signal } = round;
	let current = start;
	const seen = new Set<string>();

	for (let hop = 0; ; hop++) {
		validateAssetUrl(current);
		if (seen.has(current)) {
			throw new DownloadError('redirect-loop', current, `Redirect loop at ${current}`);
		}
		seen.add(current);
		if (resolveHost) await checkResolved(new URL(current).hostname, current, resolveHost);

		let response: DownloadFetchResponse;
		try {
			response = await fetchImpl(current, { headers, signal });
		} catch (error) {
			if (error instanceof DownloadError) throw error;
			if (signal.aborted) {
				const reason = signal.reason;
				// The timeout and internal aborts arrive as DownloadError;
				// anything else is the caller's own reason, propagated as-is.
				if (reason instanceof DownloadError || reason instanceof Error) throw reason;
				throw new DownloadError('aborted', current, `Download aborted: ${current}`);
			}
			throw new DownloadError('network-error', current, `Fetch failed for ${current}: ${error instanceof Error ? error.message : String(error)}`);
		}

		// A fetcher that followed redirects itself reports where it
		// landed; that landing is validated as a hop of its own.
		if (response.url && response.url !== current) {
			validateAssetUrl(response.url);
			if (resolveHost) await checkResolved(new URL(response.url).hostname, response.url, resolveHost);
			current = response.url;
		}

		if (REDIRECT_STATUS.has(response.status)) {
			if (hop >= maxRedirects) {
				throw new DownloadError('too-many-redirects', current, `More than ${maxRedirects} redirects from ${start}`);
			}
			const location = response.headers.get('location');
			if (!location) throw new DownloadError('network-error', current, `Redirect (${response.status}) without a Location: ${current}`);
			try {
				// Drain the redirect body so the connection can be reused.
				await response.body?.cancel().catch(() => undefined);
			} catch { /* a redirect body that will not drain is harmless */ }
			current = new URL(location, current).toString();
			continue;
		}
		return { response, finalUrl: current };
	}
}

/** Reads a body stream under a byte budget, reporting progress. */
async function readCapped(
	url: string,
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	total: number | undefined,
	onProgress?: (received: number, total?: number) => void,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let received = 0;
	if (body) {
		const reader = body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > maxBytes) {
					throw new DownloadError('too-large', url, `Body exceeds the ${maxBytes} byte limit: ${url}`);
				}
				chunks.push(value);
				onProgress?.(received, total);
			}
		} finally {
			reader.releaseLock();
		}
	}
	onProgress?.(received, total);

	const bytes = new Uint8Array(received);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}

/** Parses a `content-length` header, undefined when absent or malformed. */
function parseContentLength(headers: Pick<Headers, 'get'>): number | undefined {
	const declared = headers.get('content-length');
	return declared !== null && /^\d+$/.test(declared.trim()) ? Number.parseInt(declared.trim(), 10) : undefined;
}

/**
 * Parses a `retry-after` header into seconds: a plain delay, or an HTTP
 * date counted down to now (clamped at zero). Undefined when absent or
 * malformed.
 */
export function parseRetryAfter(value: string | null): number | undefined {
	if (value === null) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, Math.round((at - Date.now()) / 1000));
}

/**
 * Downloads one URL under guard: scheme and host checked before every
 * request, redirects followed manually up to `maxRedirects` (each hop
 * re-validated), content type and length enforced, the body streamed under
 * a byte budget and a wall clock.
 */
export async function downloadUrl(url: string, options: DownloadOptions = {}): Promise<DownloadedBytes> {
	const {
		fetchImpl = defaultDownloadFetch(),
		resolveHost,
		maxBytes = DEFAULT_MAX_BYTES,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		maxRedirects = DEFAULT_MAX_REDIRECTS,
		accept = DEFAULT_ACCEPT,
		headers,
		onProgress,
	} = options;

	return withDownloadClock(url, timeoutMs, options.signal, async (signal) => {
		const { response: final, finalUrl: current } = await roundTrip(url, { fetchImpl, resolveHost, maxRedirects, headers, signal });
		if (final.status < 200 || final.status >= 300) {
			throw new DownloadError('http-error', current, `HTTP ${final.status} for ${current}`, final.status);
		}
		const rawType = final.headers.get('content-type');
		const contentType = rawType?.split(';')[0]?.trim().toLowerCase() ?? '';
		if (!contentType) throw new DownloadError('content-type', current, `No content type for ${current}`);
		if (!accept.some((prefix) => contentType.startsWith(prefix.toLowerCase()))) {
			throw new DownloadError('content-type', current, `Refused content type ${contentType || '(none)'} for ${current}`);
		}
		const total = parseContentLength(final.headers);
		if (total !== undefined && total > maxBytes) {
			throw new DownloadError('too-large', current, `Declared ${total} bytes exceeds the ${maxBytes} byte limit: ${current}`);
		}
		const bytes = await readCapped(current, final.body, maxBytes, total, onProgress);
		return { bytes, finalUrl: current, contentType };
	});
}

/** Default ceiling for one provider API response: 8 MiB of JSON is plenty. */
export const DEFAULT_JSON_MAX_BYTES = 8 * 1024 * 1024;

export interface GuardedJsonOptions {
	/** The fetch implementation; runtime default when unset. */
	fetchImpl?: DownloadFetch;
	/** Hostname resolver; every resolved address must pass the blocklist. */
	resolveHost?: (host: string) => Promise<string[]>;
	/** Byte ceiling for the response body. */
	maxBytes?: number;
	/** Wall clock for the whole fetch, redirects included. */
	timeoutMs?: number;
	/** Redirect budget. */
	maxRedirects?: number;
	/** Extra request headers (user agent, authorization). */
	headers?: Record<string, string>;
	/** Caller cancellation. */
	signal?: AbortSignal;
}

export interface GuardedJsonResult {
	status: number;
	/**
	 * The parsed body. Null on 429/5xx (the provider interprets those
	 * itself) and on empty 2xx bodies.
	 */
	body: unknown;
	retryAfter?: number;
	/** The URL the body actually came from, after redirects. */
	finalUrl: string;
}

/**
 * GETs JSON under the same guards as downloads — validated hops, resolved
 * DNS, redirect budget, byte ceiling, wall clock — but HTTP statuses pass
 * through instead of throwing, so providers can read 429s and errors
 * themselves. What the provider registry's `fetchJson` is built on.
 */
export async function fetchJsonGuarded(url: string, options: GuardedJsonOptions = {}): Promise<GuardedJsonResult> {
	const {
		fetchImpl = defaultDownloadFetch(),
		resolveHost,
		maxBytes = DEFAULT_JSON_MAX_BYTES,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		maxRedirects = DEFAULT_MAX_REDIRECTS,
		headers,
	} = options;

	return withDownloadClock(url, timeoutMs, options.signal, async (signal) => {
		const { response: final, finalUrl: current } = await roundTrip(url, { fetchImpl, resolveHost, maxRedirects, headers, signal });
		const retryAfter = parseRetryAfter(final.headers.get('retry-after'));
		if (final.status === 429 || final.status >= 500) {
			try {
				await final.body?.cancel().catch(() => undefined);
			} catch { /* an error body that will not drain is harmless */ }
			return { status: final.status, body: null, retryAfter, finalUrl: current };
		}
		const total = parseContentLength(final.headers);
		if (total !== undefined && total > maxBytes) {
			throw new DownloadError('too-large', current, `Declared ${total} bytes exceeds the ${maxBytes} byte limit: ${current}`);
		}
		const bytes = await readCapped(current, final.body, maxBytes, total);
		if (!bytes.byteLength) return { status: final.status, body: null, retryAfter, finalUrl: current };
		try {
			return { status: final.status, body: JSON.parse(new TextDecoder().decode(bytes)), retryAfter, finalUrl: current };
		} catch {
			throw new DownloadError('content-type', current, `HTTP ${final.status} with an unparsable body (expected JSON): ${current}`, final.status);
		}
	});
}
