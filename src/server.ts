import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import {
	type ConsentRules,
	DEFAULT_CONSENT_RULES,
	normalizeCountry,
	resolveRegion
} from './regions';

type HeaderSource = { get: (name: string) => string | null };

/** Country headers set by common CDNs. Only pass a header your edge proxy
 *  always overwrites; a client can send any of these itself. */
export const CDN_COUNTRY_HEADERS: readonly string[] = [
	'cf-ipcountry',
	'cloudfront-viewer-country',
	'x-vercel-ip-country',
	'fastly-geo-country-code'
];

/** `Sec-GPC: 1` is the Global Privacy Control request signal. */
export const readGpcHeader = (headers: HeaderSource) =>
	headers.get('sec-gpc')?.trim() === '1';

export const countryFromHeaders = (
	headers: HeaderSource,
	trustedHeaders: readonly string[]
) => {
	for (const name of trustedHeaders) {
		const country = normalizeCountry(headers.get(name));
		if (country) return country;
	}

	return null;
};

export type ClientIpOptions = {
	/** A header your proxy sets to the connecting address, overwriting any
	 *  client value (nginx `proxy_set_header X-Real-IP $remote_addr`). */
	trustedHeader?: string;
	/** Proxies that append to X-Forwarded-For. The client address is this
	 *  many entries from the right; entries further left are client-supplied. */
	trustedProxyHops?: number;
};

/** The visitor address as reported by trusted proxies, or null. */
export const clientIpFromHeaders = (
	headers: HeaderSource,
	{ trustedHeader, trustedProxyHops = 0 }: ClientIpOptions
) => {
	if (trustedHeader) {
		const value = headers.get(trustedHeader)?.trim();
		if (value) return value;
	}
	if (trustedProxyHops < 1) return null;
	const chain = (headers.get('x-forwarded-for') ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);

	return chain.at(-trustedProxyHops) ?? null;
};

const IPV4_OCTETS = 4;
const OCTET_MAX = 255;
const OCTET_BITS = 8;
const IPV6_GROUPS = 8;
const GROUP_BITS = 16n;
const GROUP_MAX = 0xffff;
const HEX = 16;
const DECIMAL = 10;
const NOT_FOUND = -1;
const IPV4_BITS = 32n;
const MAPPED_MARKER = 0xffffn;
const IPV4_MAPPED_PREFIX = MAPPED_MARKER << IPV4_BITS;
const IPV4_SPACE = 1n << IPV4_BITS;
const COMPRESSED_HALVES = 2;
const ZERO_ADDRESS = 0n;

export const parseIpv4 = (value: string) => {
	const parts = value.split('.');
	if (parts.length !== IPV4_OCTETS) return null;
	let result = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = parseInt(part, DECIMAL);
		if (octet > OCTET_MAX) return null;
		result = result * (1 << OCTET_BITS) + octet;
	}

	return result;
};

const parseGroups = (section: string) => {
	if (section === '') return [];
	const groups: number[] = [];
	for (const group of section.split(':')) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
		groups.push(parseInt(group, HEX));
	}

	return groups;
};

export const parseIpv6 = (input: string) => {
	let value = input.trim().replace(/^\[|\]$/g, '');
	const zone = value.indexOf('%');
	if (zone >= 0) value = value.slice(0, zone);
	// Rewrite a trailing dotted IPv4 (`::ffff:1.2.3.4`) as two hex groups.
	const lastColon = value.lastIndexOf(':');
	const embedded = value.slice(lastColon + 1);
	if (embedded.includes('.')) {
		const ipv4 = parseIpv4(embedded);
		if (ipv4 === null) return null;
		const high = Math.floor(ipv4 / (GROUP_MAX + 1)).toString(HEX);
		const low = (ipv4 % (GROUP_MAX + 1)).toString(HEX);
		value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
	}
	const halves = value.split('::');
	if (halves.length > COMPRESSED_HALVES) return null;
	const head = parseGroups(halves[0] ?? '');
	const rest =
		halves.length === COMPRESSED_HALVES ? parseGroups(halves[1] ?? '') : [];
	if (head === null || rest === null) return null;
	const explicit = head.length + rest.length;
	if (halves.length === 1 && explicit !== IPV6_GROUPS) return null;
	if (halves.length === COMPRESSED_HALVES && explicit >= IPV6_GROUPS)
		return null;
	const groups = [
		...head,
		...Array<number>(IPV6_GROUPS - explicit).fill(0),
		...rest
	];

	return groups.reduce(
		(total, group) => (total << GROUP_BITS) + BigInt(group),
		ZERO_ADDRESS
	);
};

type Ipv4Table = { codes: string[]; ends: Uint32Array; starts: Uint32Array };
type Ipv6Table = { codes: string[]; ends: bigint[]; starts: bigint[] };

const search = <Value extends number | bigint>(
	starts: ArrayLike<Value>,
	ends: ArrayLike<Value>,
	target: Value
) => {
	let low = 0;
	let high = starts.length - 1;
	while (low <= high) {
		const middle = (low + high) >>> 1;
		const start = starts[middle];
		const end = ends[middle];
		if (start === undefined || end === undefined) return NOT_FOUND;
		if (target < start) high = middle - 1;
		else if (target > end) low = middle + 1;
		else return middle;
	}

	return NOT_FOUND;
};

const createIndexBuilder = () => {
	const ipv4Rows: { codes: string[]; ends: number[]; starts: number[] } = {
		codes: [],
		ends: [],
		starts: []
	};
	const ipv6Rows: Ipv6Table = { codes: [], ends: [], starts: [] };
	const add = (line: string) => {
		const [start = '', end = '', code = ''] = line.trim().split(',');
		const country = normalizeCountry(code.replaceAll('"', ''));
		if (!country) return;
		const from = start.replaceAll('"', '');
		const upper = end.replaceAll('"', '');
		if (from.includes(':')) {
			const low = parseIpv6(from);
			const high = parseIpv6(upper);
			if (low === null || high === null) return;
			ipv6Rows.starts.push(low);
			ipv6Rows.ends.push(high);
			ipv6Rows.codes.push(country);

			return;
		}
		const low = parseIpv4(from);
		const high = parseIpv4(upper);
		if (low === null || high === null) return;
		ipv4Rows.starts.push(low);
		ipv4Rows.ends.push(high);
		ipv4Rows.codes.push(country);
	};
	const finish = () => {
		const ipv4: Ipv4Table = {
			codes: ipv4Rows.codes,
			ends: Uint32Array.from(ipv4Rows.ends),
			starts: Uint32Array.from(ipv4Rows.starts)
		};
		const lookupV4 = (address: number) =>
			ipv4.codes[search(ipv4.starts, ipv4.ends, address)] ?? null;

		return {
			size: ipv4.codes.length + ipv6Rows.codes.length,
			/** Country for an IPv4/IPv6 address string, or null if unlisted. */
			lookup: (address: string) => {
				const ipv4Address = parseIpv4(address.trim());
				if (ipv4Address !== null) return lookupV4(ipv4Address);
				const ipv6Address = parseIpv6(address);
				if (ipv6Address === null) return null;
				const mapped = ipv6Address - IPV4_MAPPED_PREFIX;
				if (mapped >= ZERO_ADDRESS && mapped < IPV4_SPACE)
					return lookupV4(parseInt(mapped.toString(HEX), HEX));

				return (
					ipv6Rows.codes[
						search(ipv6Rows.starts, ipv6Rows.ends, ipv6Address)
					] ?? null
				);
			}
		};
	};

	return { add, finish };
};

/** Builds an in-memory IP→country index from DB-IP's country CSV
 *  (`start,end,CC` rows, ascending, IPv4 then IPv6). Synchronous; prefer
 *  {@link buildIpCountryIndex} for a full database inside a server. */
export const createIpCountryIndex = (csv: string) => {
	const builder = createIndexBuilder();
	for (const line of csv.split('\n')) builder.add(line);

	return builder.finish();
};

const DEFAULT_CHUNK_LINES = 5_000;

/** Same as {@link createIpCountryIndex} but yields to the event loop
 *  between chunks, so indexing the full ~700k-row database (about 2s of
 *  CPU) never stalls in-flight requests. */
export const buildIpCountryIndex = async (
	csv: string,
	chunkLines = DEFAULT_CHUNK_LINES
) => {
	const builder = createIndexBuilder();
	const lines = csv.split('\n');
	const offsets = Array.from(
		{ length: Math.ceil(lines.length / chunkLines) },
		(_, chunk) => chunk * chunkLines
	);
	await offsets.reduce(
		(previous, offset) =>
			previous.then(async () => {
				const end = Math.min(lines.length, offset + chunkLines);
				for (let line = offset; line < end; line += 1)
					builder.add(lines[line] ?? '');
				// Let queued requests run between chunks.
				await sleep(0);

				return end;
			}),
		Promise.resolve(0)
	);

	return builder.finish();
};

export type IpCountryIndex = ReturnType<typeof createIpCountryIndex>;

export type DbIpResolverOptions = {
	/** Directory for the downloaded monthly database. */
	cacheDir: string;
	fetch?: typeof fetch;
	/** Reported whenever a download or parse fails; lookups return null
	 *  until a database loads. */
	onError?: (error: unknown) => void;
	now?: () => number;
	/** Re-download once the cached file is older than this. */
	refreshAfterMs?: number;
};

const DAY_MS = 86_400_000;
const DEFAULT_REFRESH_DAYS = 35;
const FILE_PATTERN = /^dbip-country-lite-(\d{4}-\d{2})\.csv\.gz$/;
const MONTH_DIGITS = 2;

const monthKey = (time: number, monthsBack: number) => {
	const date = new Date(time);
	date.setUTCDate(1);
	date.setUTCMonth(date.getUTCMonth() - monthsBack);

	const month = `${date.getUTCMonth() + 1}`.padStart(MONTH_DIGITS, '0');

	return `${date.getUTCFullYear()}-${month}`;
};

/** IP→country using the free DB-IP "IP to Country Lite" database (CC BY
 *  4.0 — show "IP Geolocation by DB-IP" with a link to https://db-ip.com
 *  where you disclose it). Loads the newest cached copy, downloads a fresh
 *  one when it is missing or stale, and never blocks a lookup on the
 *  network. */
export const createDbIpCountryResolver = ({
	cacheDir,
	fetch: fetcher = fetch,
	now = Date.now,
	onError,
	refreshAfterMs = DEFAULT_REFRESH_DAYS * DAY_MS
}: DbIpResolverOptions) => {
	let index: IpCountryIndex | null = null;
	let loadedAt = 0;
	let pending: Promise<void> | null = null;
	let lastAttempt = 0;

	const load = async (path: string) => {
		const bytes = await readFile(path);
		const next = await buildIpCountryIndex(
			new TextDecoder().decode(gunzipSync(bytes))
		);
		if (next.size === 0) throw new Error(`Empty DB-IP database: ${path}`);
		index = next;
		loadedAt = (await stat(path)).mtimeMs;
	};
	const newestCached = async () => {
		const names = await readdir(cacheDir).catch(() => []);
		const newest = names
			.filter((name) => FILE_PATTERN.test(name))
			.sort()
			.at(NOT_FOUND);

		return newest ? join(cacheDir, newest) : null;
	};
	const fetchMonth = async (monthsBack: number) => {
		const name = `dbip-country-lite-${monthKey(now(), monthsBack)}.csv.gz`;
		const response = await fetcher(
			`https://download.db-ip.com/free/${name}`
		);
		if (!response.ok) return false;
		const path = join(cacheDir, name);
		await writeFile(path, new Uint8Array(await response.arrayBuffer()));
		await load(path);

		return true;
	};
	const download = async () => {
		await mkdir(cacheDir, { recursive: true });
		// The current month is published early in the month; fall back to
		// the previous one until it appears.
		if (await fetchMonth(0)) return;
		if (await fetchMonth(1)) return;
		throw new Error('No DB-IP country database is available to download.');
	};
	const refresh = async () => {
		lastAttempt = now();
		try {
			const cached = index ? null : await newestCached();
			if (cached) await load(cached);
			if (!index || now() - loadedAt > refreshAfterMs) await download();
		} catch (error) {
			onError?.(error);
		}
	};
	const ensureFresh = () => {
		const stale = !index || now() - loadedAt > refreshAfterMs;
		if (!stale || pending || now() - lastAttempt < DAY_MS) return pending;
		pending = refresh().finally(() => {
			pending = null;
		});

		return pending;
	};

	return {
		/** Country for an address; null until a database has loaded. */
		lookup: (address: string | null | undefined) => {
			void ensureFresh();

			return address && index ? index.lookup(address) : null;
		},
		/** Resolves once the first load (cache or download) settles. */
		ready: () => ensureFresh() ?? Promise.resolve()
	};
};

export type RequestRegionOptions = ClientIpOptions & {
	/** Trusted edge country headers, checked before the IP lookup. */
	countryHeaders?: readonly string[];
	lookup?: (address: string | null) => string | null;
	rules?: ConsentRules;
	/** Browser zone if the client sent one (e.g. a cookie). */
	timeZone?: string | null;
};

/** Region and GPC for a request, for seeding the browser store during SSR
 *  so the right banner renders on first paint. */
export const resolveRequestRegion = (
	headers: HeaderSource,
	{
		countryHeaders = [],
		lookup,
		rules = DEFAULT_CONSENT_RULES,
		timeZone,
		...ipOptions
	}: RequestRegionOptions
) => {
	const country =
		countryFromHeaders(headers, countryHeaders) ??
		lookup?.(clientIpFromHeaders(headers, ipOptions)) ??
		null;

	return {
		...resolveRegion({ country, rules, timeZone }),
		gpc: readGpcHeader(headers)
	};
};
