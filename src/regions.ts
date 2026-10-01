/** ISO 3166-1 alpha-2 codes of the European Economic Area (EU + IS, LI, NO). */
export const EEA_COUNTRIES: readonly string[] = [
	'AT',
	'BE',
	'BG',
	'CY',
	'CZ',
	'DE',
	'DK',
	'EE',
	'ES',
	'FI',
	'FR',
	'GR',
	'HR',
	'HU',
	'IE',
	'IS',
	'IT',
	'LI',
	'LT',
	'LU',
	'LV',
	'MT',
	'NL',
	'NO',
	'PL',
	'PT',
	'RO',
	'SE',
	'SI',
	'SK'
];

/** Jurisdictions whose ePrivacy/GDPR-style rules require opt-in for
 *  non-essential cookies: the EEA, the United Kingdom and Switzerland. */
export const OPT_IN_REQUIRED_COUNTRIES: readonly string[] = [
	...EEA_COUNTRIES,
	'CH',
	'GB'
];

/** IANA zones whose tzdb country is the United States (zone.tab `US`), plus
 *  the legacy aliases browsers may still report. Territories are excluded. */
export const US_TIME_ZONES: readonly string[] = [
	'America/Adak',
	'America/Anchorage',
	'America/Boise',
	'America/Chicago',
	'America/Denver',
	'America/Detroit',
	'America/Fort_Wayne',
	'America/Indiana/Indianapolis',
	'America/Indiana/Knox',
	'America/Indiana/Marengo',
	'America/Indiana/Petersburg',
	'America/Indiana/Tell_City',
	'America/Indiana/Vevay',
	'America/Indiana/Vincennes',
	'America/Indiana/Winamac',
	'America/Indianapolis',
	'America/Juneau',
	'America/Kentucky/Louisville',
	'America/Kentucky/Monticello',
	'America/Knox_IN',
	'America/Los_Angeles',
	'America/Louisville',
	'America/Menominee',
	'America/Metlakatla',
	'America/New_York',
	'America/Nome',
	'America/North_Dakota/Beulah',
	'America/North_Dakota/Center',
	'America/North_Dakota/New_Salem',
	'America/Phoenix',
	'America/Shiprock',
	'America/Sitka',
	'America/Yakutat',
	'Navajo',
	'Pacific/Honolulu',
	'US/Alaska',
	'US/Aleutian',
	'US/Arizona',
	'US/Central',
	'US/East-Indiana',
	'US/Eastern',
	'US/Hawaii',
	'US/Indiana-Starke',
	'US/Michigan',
	'US/Mountain',
	'US/Pacific'
];

export type ConsentRegime = 'opt-in' | 'opt-out';

/** Where the visitor's country came from. `unknown` always resolves to the
 *  rules' fallback regime. */
export type RegionSource = 'country' | 'timezone' | 'unknown';

export type ConsentRules = {
	/** Regime for every country not listed, and for unknown visitors. */
	fallback: ConsentRegime;
	/** Countries where tracking defaults on and the visitor may opt out. */
	optOutCountries: readonly string[];
};

export type RegionInput = {
	/** ISO 3166-1 alpha-2 code from a trusted source (IP lookup, CDN header). */
	country?: string | null;
	rules?: ConsentRules;
	/** Browser IANA zone; only consulted when `country` is absent. */
	timeZone?: string | null;
};

export type RegionResolution = {
	country: string | null;
	regime: ConsentRegime;
	source: RegionSource;
};

/** Opt-out only where the visitor is known to be in the United States;
 *  opt-in everywhere else, including when the location is unknown. */
export const DEFAULT_CONSENT_RULES: ConsentRules = {
	fallback: 'opt-in',
	optOutCountries: ['US']
};

const COUNTRY_CODE = /^[A-Z]{2}$/;

/** Normalizes an alpha-2 code; returns null for placeholders such as
 *  `XX`/`ZZ`/`T1` that CDNs and IP databases use for unknown or Tor. */
export const normalizeCountry = (value: string | null | undefined) => {
	const code = value?.trim().toUpperCase() ?? '';
	if (!COUNTRY_CODE.test(code) || code === 'XX' || code === 'ZZ') return null;

	return code;
};

const usZones = new Set(US_TIME_ZONES);

/** Best-effort country from a browser time zone. Only countries the default
 *  rules distinguish are inferred; every other zone yields null. */
export const countryFromTimeZone = (timeZone: string | null | undefined) =>
	timeZone && usZones.has(timeZone) ? 'US' : null;

export const resolveRegion = ({
	country,
	rules = DEFAULT_CONSENT_RULES,
	timeZone
}: RegionInput) => {
	const regimeFor = (code: string) =>
		rules.optOutCountries.includes(code) ? 'opt-out' : rules.fallback;
	const known = normalizeCountry(country);
	if (known) {
		const resolved: RegionResolution = {
			country: known,
			regime: regimeFor(known),
			source: 'country'
		};

		return resolved;
	}
	const inferred = countryFromTimeZone(timeZone);
	if (inferred) {
		const resolved: RegionResolution = {
			country: inferred,
			regime: regimeFor(inferred),
			source: 'timezone'
		};

		return resolved;
	}
	const resolved: RegionResolution = {
		country: null,
		regime: rules.fallback,
		source: 'unknown'
	};

	return resolved;
};
