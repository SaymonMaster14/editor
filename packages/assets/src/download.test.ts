/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';

import {
	blockedHostReason,
	DownloadError,
	downloadUrl,
	fetchJsonGuarded,
	parseRetryAfter,
	validateAssetUrl,
} from './download';

import type { DownloadFetch, DownloadFetchResponse } from './download';

function headers(entries: Record<string, string> = {}): Pick<Headers, 'get'> {
	const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
	return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function stream(bytes: Uint8Array, chunkSize = 4): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (let at = 0; at < bytes.byteLength; at += chunkSize) {
				controller.enqueue(bytes.slice(at, at + chunkSize));
			}
			controller.close();
		},
	});
}

function ok(body = 'bytes', type = 'image/png'): DownloadFetchResponse {
	const bytes = new TextEncoder().encode(body);
	return {
		status: 200,
		headers: headers({ 'content-type': type, 'content-length': String(bytes.byteLength) }),
		body: stream(bytes),
	};
}

function redirectTo(location: string): DownloadFetchResponse {
	return { status: 302, headers: headers({ location }), body: null };
}

describe('blockedHostReason', () => {
	const blocked = [
		'localhost',
		'LOCALHOST',
		'foo.localhost',
		'127.0.0.1',
		'127.1',
		'127.0.1',
		'2130706433',
		'0x7f.0.0.1',
		'0177.0.0.1',
		'10.0.0.1',
		'10.255.1.2',
		'172.16.0.1',
		'172.31.255.255',
		'192.168.0.1',
		'169.254.169.254',
		'100.64.0.1',
		'0.0.0.0',
		'224.0.0.1',
		'255.255.255.255',
		'192.0.2.1',
		'198.51.100.2',
		'203.0.113.3',
		'::1',
		'[::1]',
		'::',
		'fe80::1',
		'[fe80::abcd]',
		'fc00::1',
		'ff02::1',
		'::ffff:127.0.0.1',
		'::ffff:10.0.0.1',
		'metadata.google.internal',
		'metadata.google',
	];
	for (const host of blocked) {
		it(`refuses ${host}`, () => {
			expect(blockedHostReason(host)).toBeTruthy();
		});
	}

	const allowed = [
		'commons.wikimedia.org',
		'upload.wikimedia.org',
		'images.pexels.com',
		'172.32.0.1',
		'172.15.255.255',
		'8.8.8.8',
		'1.1.1.1',
		'192.167.1.1',
		'::ffff:8.8.8.8',
		'2606:4700:4700::1111',
	];
	for (const host of allowed) {
		it(`allows ${host}`, () => {
			expect(blockedHostReason(host)).toBeUndefined();
		});
	}
});

describe('validateAssetUrl', () => {
	it('refuses non-http schemes', () => {
		for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'data:image/png;base64,xx', 'C:\\temp\\x.png', '/abs/path.png', 'relative.png']) {
			expect(() => validateAssetUrl(url), url).toThrowError(DownloadError);
		}
	});

	it('refuses blocked hosts', () => {
		expect(() => validateAssetUrl('http://localhost:3000/x')).toThrowError(/Refused host/);
		expect(() => validateAssetUrl('https://127.0.0.1/x')).toThrowError(/Refused host/);
		expect(() => validateAssetUrl('http://[::1]/x')).toThrowError(/Refused host/);
	});

	it('accepts public http(s) URLs', () => {
		expect(() => validateAssetUrl('https://upload.wikimedia.org/x.png')).not.toThrow();
		expect(() => validateAssetUrl('http://8.8.8.8/x.png')).not.toThrow();
	});
});

describe('downloadUrl', () => {
	const resolvePublic = async () => ['93.184.216.34'];

	it('downloads bytes and reports the final URL and type', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => ok('hello', 'image/png; charset=binary'));
		const progress: Array<[number, number | undefined]> = [];
		const result = await downloadUrl('https://example.com/a.png', {
			fetchImpl,
			resolveHost: resolvePublic,
			onProgress: (received, total) => progress.push([received, total]),
		});
		expect(new TextDecoder().decode(result.bytes)).toBe('hello');
		expect(result.finalUrl).toBe('https://example.com/a.png');
		expect(result.contentType).toBe('image/png');
		expect(progress.length).toBeGreaterThan(0);
		expect(progress[progress.length - 1]).toEqual([5, 5]);
	});

	it('never fetches a blocked URL', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => ok());
		await expect(downloadUrl('http://127.0.0.1/x.png', { fetchImpl })).rejects.toMatchObject({ code: 'blocked-url' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('checks every resolved address', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => ok());
		await expect(downloadUrl('https://evil.example/x.png', {
			fetchImpl,
			resolveHost: async () => ['93.184.216.34', '10.1.2.3'],
		})).rejects.toMatchObject({ code: 'dns-blocked' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('fails closed when resolution fails', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => ok());
		await expect(downloadUrl('https://nx.example/x.png', {
			fetchImpl,
			resolveHost: async () => { throw new Error('ENOTFOUND'); },
		})).rejects.toMatchObject({ code: 'network-error' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('follows redirects, validating each hop', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async (url) => {
			if (url === 'https://example.com/start') return redirectTo('/middle');
			if (url === 'https://example.com/middle') return redirectTo('https://cdn.example/file.mp4');
			return ok('video', 'video/mp4');
		});
		const result = await downloadUrl('https://example.com/start', { fetchImpl, resolveHost: resolvePublic });
		expect(result.finalUrl).toBe('https://cdn.example/file.mp4');
		expect(result.contentType).toBe('video/mp4');
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it('refuses a redirect to a blocked host', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async (url) => {
			if (url === 'https://example.com/start') return redirectTo('http://169.254.169.254/latest');
			return ok();
		});
		await expect(downloadUrl('https://example.com/start', { fetchImpl })).rejects.toMatchObject({ code: 'blocked-url' });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('refuses a redirect to a non-http scheme', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async (url) => {
			if (url === 'https://example.com/start') return redirectTo('file:///etc/passwd');
			return ok();
		});
		// `file:` against an http base resolves to the file URL; the next hop refuses it.
		await expect(downloadUrl('https://example.com/start', { fetchImpl })).rejects.toMatchObject({ code: 'blocked-url' });
	});

	it('caps the redirect chain and detects loops', async () => {
		const looping: DownloadFetch = async () => redirectTo('https://example.com/a');
		await expect(downloadUrl('https://example.com/a', { fetchImpl: looping, maxRedirects: 5 }))
			.rejects.toMatchObject({ code: 'redirect-loop' });

		let n = 0;
		const chain: DownloadFetch = async () => redirectTo(`https://example.com/${++n}`);
		await expect(downloadUrl('https://example.com/0', { fetchImpl: chain, maxRedirects: 3 }))
			.rejects.toMatchObject({ code: 'too-many-redirects' });
	});

	it('validates the landing URL a following fetcher reports', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => ({ ...ok(), url: 'http://127.0.0.1/stash.png' }));
		await expect(downloadUrl('https://example.com/start', { fetchImpl })).rejects.toMatchObject({ code: 'blocked-url' });
	});

	it('accepts a following fetcher landing on a public URL', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => ({ ...ok('pic', 'image/jpeg'), url: 'https://cdn.example/pic.jpg' }));
		const result = await downloadUrl('https://example.com/start', { fetchImpl, resolveHost: resolvePublic });
		expect(result.finalUrl).toBe('https://cdn.example/pic.jpg');
		expect(new TextDecoder().decode(result.bytes)).toBe('pic');
	});

	it('refuses declared bodies over the limit before reading', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => ({
			status: 200,
			headers: headers({ 'content-type': 'video/mp4', 'content-length': '999999999' }),
			body: stream(new TextEncoder().encode('x')),
		}));
		await expect(downloadUrl('https://example.com/big.mp4', { fetchImpl, maxBytes: 8 }))
			.rejects.toMatchObject({ code: 'too-large' });
	});

	it('cuts the stream when the body outgrows the limit', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => ({
			status: 200,
			headers: headers({ 'content-type': 'video/mp4' }),
			body: stream(new TextEncoder().encode('0123456789abcdef')),
		}));
		await expect(downloadUrl('https://example.com/stream.mp4', { fetchImpl, maxBytes: 8 }))
			.rejects.toMatchObject({ code: 'too-large' });
	});

	it('refuses unexpected and missing content types', async () => {
		const html: DownloadFetch = async () => ok('<html>', 'text/html');
		await expect(downloadUrl('https://example.com/x', { fetchImpl: html })).rejects.toMatchObject({ code: 'content-type' });
		const none: DownloadFetch = async () => ({ status: 200, headers: headers({}), body: null });
		await expect(downloadUrl('https://example.com/x', { fetchImpl: none })).rejects.toMatchObject({ code: 'content-type' });
	});

	it('honors a custom accept list', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => ok('{}', 'application/json'));
		await expect(downloadUrl('https://example.com/x.json', { fetchImpl, accept: ['application/json'] }))
			.resolves.toMatchObject({ contentType: 'application/json' });
	});

	it('reports HTTP errors with their status', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => ({ status: 404, headers: headers({}), body: null }));
		await expect(downloadUrl('https://example.com/missing.png', { fetchImpl }))
			.rejects.toMatchObject({ code: 'http-error', status: 404 });
	});

	it('times out a hanging fetch', async () => {
		const hanging: DownloadFetch = (_url, init) => new Promise((_resolve, reject) => {
			init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
		});
		await expect(downloadUrl('https://example.com/slow', { fetchImpl: hanging, timeoutMs: 50 }))
			.rejects.toMatchObject({ code: 'timeout' });
	});

	it('honors caller cancellation', async () => {
		const controller = new AbortController();
		const hanging: DownloadFetch = (_url, init) => new Promise((_resolve, reject) => {
			init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
		});
		const pending = downloadUrl('https://example.com/slow', { fetchImpl: hanging, signal: controller.signal });
		controller.abort(new Error('user stopped it'));
		await expect(pending).rejects.toThrow('user stopped it');
	});

	it('wraps fetch failures as network errors', async () => {
		const failing: DownloadFetch = async () => { throw new TypeError('fetch failed'); };
		await expect(downloadUrl('https://example.com/x.png', { fetchImpl: failing }))
			.rejects.toMatchObject({ code: 'network-error' });
	});
});

describe('parseRetryAfter', () => {
	it('reads delay seconds', () => {
		expect(parseRetryAfter('120')).toBe(120);
		expect(parseRetryAfter('  7 ')).toBe(7);
	});

	it('counts HTTP dates down to now', () => {
		const future = new Date(Date.now() + 65_000).toUTCString();
		const seconds = parseRetryAfter(future);
		expect(seconds).toBeGreaterThanOrEqual(60);
		expect(seconds).toBeLessThanOrEqual(66);
		expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
	});

	it('ignores absent and malformed values', () => {
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter('soon')).toBeUndefined();
		expect(parseRetryAfter('')).toBeUndefined();
	});
});

describe('fetchJsonGuarded', () => {
	const resolvePublic = async () => ['93.184.216.34'];

	function json(body: unknown, status = 200, extra: Record<string, string> = {}): DownloadFetchResponse {
		const bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
		return {
			status,
			headers: headers({ 'content-type': 'application/json', 'content-length': String(bytes.byteLength), ...extra }),
			body: stream(bytes),
		};
	}

	it('parses JSON bodies', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => json({ hits: [1, 2] }));
		const result = await fetchJsonGuarded('https://api.example/search', { fetchImpl, resolveHost: resolvePublic });
		expect(result).toMatchObject({ status: 200, body: { hits: [1, 2] }, finalUrl: 'https://api.example/search' });
		expect(result.retryAfter).toBeUndefined();
	});

	it('passes 429/5xx through with retry-after for the provider to read', async () => {
		const limited: DownloadFetch = async () => json({ error: 'slow down' }, 429, { 'retry-after': '30' });
		const result = await fetchJsonGuarded('https://api.example/search', { fetchImpl: limited });
		expect(result).toMatchObject({ status: 429, body: null, retryAfter: 30 });

		const broken: DownloadFetch = async () => json({ error: 'boom' }, 503);
		await expect(fetchJsonGuarded('https://api.example/search', { fetchImpl: broken }))
			.resolves.toMatchObject({ status: 503, body: null });
	});

	it('rejects unparsable bodies as content errors', async () => {
		const html: DownloadFetch = async () => json('<html>nope</html>');
		await expect(fetchJsonGuarded('https://api.example/search', { fetchImpl: html }))
			.rejects.toMatchObject({ code: 'content-type', status: 200 });
	});

	it('treats empty bodies as null', async () => {
		const empty: DownloadFetch = async () => ({ status: 200, headers: headers({}), body: null });
		await expect(fetchJsonGuarded('https://api.example/search', { fetchImpl: empty }))
			.resolves.toMatchObject({ status: 200, body: null });
	});

	it('enforces the same guards as downloads', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async () => json({}));
		await expect(fetchJsonGuarded('http://10.0.0.5/api', { fetchImpl })).rejects.toMatchObject({ code: 'blocked-url' });
		expect(fetchImpl).not.toHaveBeenCalled();

		const big: DownloadFetch = async () => json({ data: 'x'.repeat(64) });
		await expect(fetchJsonGuarded('https://api.example/search', { fetchImpl: big, maxBytes: 8 }))
			.rejects.toMatchObject({ code: 'too-large' });

		const evil: DownloadFetch = async () => json({});
		await expect(fetchJsonGuarded('https://api.example/search', {
			fetchImpl: evil,
			resolveHost: async () => ['192.168.1.1'],
		})).rejects.toMatchObject({ code: 'dns-blocked' });
	});

	it('follows redirects and reports the landing URL', async () => {
		const fetchImpl = vi.fn<DownloadFetch>(async (url) => {
			if (url === 'https://api.example/v1') return redirectTo('https://api.example/v2');
			return json({ ok: true });
		});
		const result = await fetchJsonGuarded('https://api.example/v1', { fetchImpl });
		expect(result).toMatchObject({ status: 200, body: { ok: true }, finalUrl: 'https://api.example/v2' });
	});
});
