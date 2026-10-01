import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	countryFromTimeZone,
	OPT_IN_REQUIRED_COUNTRIES,
	resolveRegion,
	US_TIME_ZONES
} from '../src';

describe('resolveRegion', () => {
	test('known US visitors are opt-out', () => {
		expect(resolveRegion({ country: 'us' })).toEqual({
			country: 'US',
			regime: 'opt-out',
			source: 'country'
		});
	});
	test('EU, UK and Swiss visitors are opt-in', () => {
		for (const country of ['DE', 'FR', 'GB', 'CH', 'NO'])
			expect(resolveRegion({ country }).regime).toBe('opt-in');
		expect(OPT_IN_REQUIRED_COUNTRIES).toContain('GB');
	});
	test('other countries and unknown visitors fall back to opt-in', () => {
		expect(resolveRegion({ country: 'CA' }).regime).toBe('opt-in');
		expect(resolveRegion({ country: 'ZZ' })).toEqual({
			country: null,
			regime: 'opt-in',
			source: 'unknown'
		});
		expect(resolveRegion({}).regime).toBe('opt-in');
	});
	test('time zone is only a fallback for a missing country', () => {
		expect(resolveRegion({ timeZone: 'America/Chicago' })).toEqual({
			country: 'US',
			regime: 'opt-out',
			source: 'timezone'
		});
		expect(
			resolveRegion({ country: 'DE', timeZone: 'America/Chicago' }).regime
		).toBe('opt-in');
		expect(resolveRegion({ timeZone: 'America/Toronto' }).regime).toBe(
			'opt-in'
		);
		expect(resolveRegion({ timeZone: 'Europe/London' }).regime).toBe(
			'opt-in'
		);
	});
	test('custom rules', () => {
		expect(
			resolveRegion({
				country: 'CA',
				rules: { fallback: 'opt-in', optOutCountries: ['US', 'CA'] }
			}).regime
		).toBe('opt-out');
	});
});

describe('US time zones', () => {
	test('cover every tzdb zone assigned to the US', () => {
		const tab = readFileSync('/usr/share/zoneinfo/zone.tab', 'utf8');
		const zones = tab
			.split('\n')
			.map((line) => line.split('\t'))
			.filter((columns) => columns[0] === 'US')
			.map((columns) => columns[2] ?? '');
		expect(zones.length).toBeGreaterThan(0);
		for (const zone of zones) expect(US_TIME_ZONES).toContain(zone);
	});
	test('exclude neighbours sharing offsets', () => {
		for (const zone of [
			'America/Toronto',
			'America/Mexico_City',
			'America/Vancouver'
		])
			expect(countryFromTimeZone(zone)).toBeNull();
	});
});
