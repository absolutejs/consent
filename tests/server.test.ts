import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
	clientIpFromHeaders,
	countryFromHeaders,
	createDbIpCountryResolver,
	createIpCountryIndex,
	parseIpv4,
	parseIpv6,
	readGpcHeader,
	resolveRequestRegion
} from '../src/server';

const SAMPLE = [
	'0.0.0.0,0.255.255.255,ZZ',
	'8.8.8.0,8.8.8.255,US',
	'81.2.69.0,81.2.69.255,GB',
	'"2001:4860::","2001:4860:ffff:ffff:ffff:ffff:ffff:ffff","US"',
	'2a00:1450::,2a00:1450:ffff:ffff:ffff:ffff:ffff:ffff,DE'
].join('\n');

describe('address parsing', () => {
	test('IPv4', () => {
		expect(parseIpv4('8.8.8.8')).toBe(0x08080808);
		expect(parseIpv4('255.255.255.255')).toBe(0xffffffff);
		expect(parseIpv4('256.0.0.1')).toBeNull();
		expect(parseIpv4('1.2.3')).toBeNull();
	});
	test('IPv6', () => {
		expect(parseIpv6('::')).toBe(0n);
		expect(parseIpv6('::1')).toBe(1n);
		expect(parseIpv6('2001:db8::1')).toBe(
			0x20010db8000000000000000000000001n
		);
		expect(parseIpv6('[fe80::1%eth0]')).toBe(
			0xfe800000000000000000000000000001n
		);
		expect(parseIpv6('::ffff:8.8.8.8')).toBe(0xffff08080808n);
		expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeNull();
		expect(parseIpv6('1::2::3')).toBeNull();
		expect(parseIpv6('gggg::')).toBeNull();
	});
});

describe('createIpCountryIndex', () => {
	const index = createIpCountryIndex(SAMPLE);
	test('looks up both families and skips unknown rows', () => {
		expect(index.size).toBe(4);
		expect(index.lookup('8.8.8.8')).toBe('US');
		expect(index.lookup('81.2.69.160')).toBe('GB');
		expect(index.lookup('0.1.2.3')).toBeNull();
		expect(index.lookup('9.9.9.9')).toBeNull();
		expect(index.lookup('2001:4860:4860::8888')).toBe('US');
		expect(index.lookup('2a00:1450:4001:80b::200e')).toBe('DE');
		expect(index.lookup('::ffff:81.2.69.1')).toBe('GB');
		expect(index.lookup('not an ip')).toBeNull();
	});
});

describe('headers', () => {
	const headers = (values: Record<string, string>) => new Headers(values);
	test('GPC', () => {
		expect(readGpcHeader(headers({ 'Sec-GPC': '1' }))).toBe(true);
		expect(readGpcHeader(headers({}))).toBe(false);
	});
	test('country only from trusted headers', () => {
		const request = headers({ 'cf-ipcountry': 'de' });
		expect(countryFromHeaders(request, [])).toBeNull();
		expect(countryFromHeaders(request, ['cf-ipcountry'])).toBe('DE');
		expect(
			countryFromHeaders(headers({ 'cf-ipcountry': 'XX' }), [
				'cf-ipcountry'
			])
		).toBeNull();
	});
	test('client IP ignores client-supplied forwarding entries', () => {
		const request = headers({
			'x-forwarded-for': '6.6.6.6, 8.8.8.8',
			'x-real-ip': '81.2.69.1'
		});
		expect(
			clientIpFromHeaders(request, { trustedHeader: 'x-real-ip' })
		).toBe('81.2.69.1');
		expect(clientIpFromHeaders(request, { trustedProxyHops: 1 })).toBe(
			'8.8.8.8'
		);
		expect(clientIpFromHeaders(request, {})).toBeNull();
	});
	test('resolveRequestRegion', () => {
		const index = createIpCountryIndex(SAMPLE);
		const lookup = (address: string | null) =>
			address ? index.lookup(address) : null;
		expect(
			resolveRequestRegion(
				headers({ 'Sec-GPC': '1', 'x-real-ip': '8.8.8.8' }),
				{
					lookup,
					trustedHeader: 'x-real-ip'
				}
			)
		).toEqual({
			country: 'US',
			gpc: true,
			regime: 'opt-out',
			source: 'country'
		});
		expect(
			resolveRequestRegion(headers({ 'x-real-ip': '81.2.69.1' }), {
				lookup,
				timeZone: 'America/New_York',
				trustedHeader: 'x-real-ip'
			}).regime
		).toBe('opt-in');
		expect(
			resolveRequestRegion(headers({}), {
				lookup,
				timeZone: 'America/New_York'
			})
		).toMatchObject({ regime: 'opt-out', source: 'timezone' });
	});
});

describe('createDbIpCountryResolver', () => {
	const gz = gzipSync(Buffer.from(SAMPLE));
	test('downloads the current month, caches it, and answers lookups', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'consent-'));
		const requested: string[] = [];
		const resolver = createDbIpCountryResolver({
			cacheDir: dir,
			fetch: async (url) => {
				requested.push(String(url));

				return new Response(gz);
			},
			now: () => Date.UTC(2026, 9, 1)
		});
		expect(resolver.lookup('8.8.8.8')).toBeNull();
		await resolver.ready();
		expect(resolver.lookup('8.8.8.8')).toBe('US');
		expect(requested).toEqual([
			'https://download.db-ip.com/free/dbip-country-lite-2026-10.csv.gz'
		]);
		expect(readdirSync(dir)).toEqual(['dbip-country-lite-2026-10.csv.gz']);
	});
	test('falls back to the previous month', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'consent-'));
		const resolver = createDbIpCountryResolver({
			cacheDir: dir,
			fetch: async (url) =>
				String(url).includes('2026-01')
					? new Response(gz)
					: new Response('', { status: 404 }),
			now: () => Date.UTC(2026, 1, 1)
		});
		await resolver.ready();
		expect(resolver.lookup('81.2.69.9')).toBe('GB');
	});
	test('loads a fresh cache without the network', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'consent-'));
		writeFileSync(join(dir, 'dbip-country-lite-2026-09.csv.gz'), gz);
		const resolver = createDbIpCountryResolver({
			cacheDir: dir,
			fetch: () => Promise.reject(new Error('network used')),
			onError: (error) => {
				throw error;
			}
		});
		await resolver.ready();
		expect(resolver.lookup('8.8.8.8')).toBe('US');
	});
	test('reports failures and keeps answering null', async () => {
		const errors: unknown[] = [];
		const resolver = createDbIpCountryResolver({
			cacheDir: mkdtempSync(join(tmpdir(), 'consent-')),
			fetch: async () => new Response('', { status: 503 }),
			onError: (error) => errors.push(error)
		});
		await resolver.ready();
		expect(resolver.lookup('8.8.8.8')).toBeNull();
		expect(errors).toHaveLength(1);
	});
});

const REAL = process.env.DBIP_SAMPLE;
test.skipIf(!REAL)(
	'real DB-IP file parses and resolves well-known addresses',
	async () => {
		const { gunzipSync } = await import('node:zlib');
		const { readFileSync } = await import('node:fs');
		const started = performance.now();
		const index = createIpCountryIndex(
			gunzipSync(readFileSync(REAL ?? '')).toString()
		);
		const elapsed = performance.now() - started;
		console.warn(
			`indexed ${index.size} ranges in ${Math.round(elapsed)}ms`
		);
		expect(index.size).toBeGreaterThan(500_000);
		expect(index.lookup('8.8.8.8')).toBe('US');
		expect(index.lookup('2001:4860:4801::1')).toBe('US');
		expect(index.lookup('2001:4860:4860::8888')).toBe('CA');
		expect(index.lookup('81.2.69.142')).toBe('GB');
		expect(index.lookup('193.99.144.80')).toBe('DE');
	}
);

test.skipIf(!REAL)(
	'building the real database never blocks the event loop for long',
	async () => {
		const { gunzipSync } = await import('node:zlib');
		const { readFileSync } = await import('node:fs');
		const { buildIpCountryIndex } = await import('../src/server');
		const csv = gunzipSync(readFileSync(REAL ?? '')).toString();
		let longest = 0;
		let last = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			longest = Math.max(longest, now - last);
			last = now;
		}, 1);
		const index = await buildIpCountryIndex(csv);
		clearInterval(timer);
		console.warn(`longest event-loop stall ${Math.round(longest)}ms`);
		expect(index.lookup('81.2.69.142')).toBe('GB');
		expect(longest).toBeLessThan(100);
	}
);
