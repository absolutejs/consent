# `@absolutejs/consent`

Region-aware tracking consent for AbsoluteJS apps.

- **Opt-out where the law allows it, opt-in where it requires it.** The
  default rules give confirmed US visitors tracking-on with a notice and a way
  to opt out, and everyone else — the EEA, the UK, Switzerland, every other
  country, and anyone whose location is unknown — an opt-in prompt with
  everything off until they choose.
- **Global Privacy Control.** A `Sec-GPC: 1` request or
  `navigator.globalPrivacyControl` turns opt-out defaults off.
- **Location without a CDN.** An IP→country index built from the free DB-IP
  Lite database, downloaded and cached by the server, with the browser time
  zone as a fallback. A trusted CDN country header can be used instead.
- **Decisions follow the account.** A choice saved on one device can be
  applied on another; the newer decision always wins.

This package decides *defaults*. It is not legal advice; choose rules with
counsel for the jurisdictions you serve.

## Browser

```ts
import { createConsentStore, readGpc, readTimeZone, resolveRegion } from '@absolutejs/consent';

const store = createConsentStore({
	categories: ['analytics', 'marketing'],
	gpc: readGpc(),
	// Seed from SSR (see below) so the right UI renders on first paint;
	// otherwise fall back to the browser time zone.
	region: ssrRegion ?? resolveRegion({ timeZone: readTimeZone() })
});

store.subscribe((state) => {
	if (state.choices.analytics) startAnalytics();
	else stopAnalytics();
});

store.getState().needsPrompt; // opt-in region, undecided → show the banner
store.getState().needsNotice; // opt-out region, undecided → show a notice
store.acceptAll();
store.rejectAll();
store.decide({ analytics: true });
store.dismissNotice(); // hides the notice, records no decision
store.applyRemote({ choices: { analytics: false }, decidedAt }); // from the account
```

Decisions persist in `localStorage` under `absolute-consent`. Pass `migrate`
to read an older storage format, `storage: null` for memory only.

## Server

```ts
import { createDbIpCountryResolver, resolveRequestRegion } from '@absolutejs/consent/server';

const geo = createDbIpCountryResolver({ cacheDir: '.cache/geo', onError: console.error });
void geo.ready();

const region = resolveRequestRegion(request.headers, {
	lookup: geo.lookup,
	// nginx: proxy_set_header X-Real-IP $remote_addr;
	trustedHeader: 'x-real-ip'
});
// { country: 'US', regime: 'opt-out', source: 'country', gpc: false }
```

Only name headers your own proxy overwrites. `X-Forwarded-For` entries left
of your trusted hops, and CDN country headers your edge does not set, are
client-controlled.

The resolver loads the newest cached database, downloads the current month
from DB-IP when the cache is missing or older than 35 days (falling back to
the previous month early in a month), indexes it in chunks that yield to the
event loop, and returns `null` until it has loaded — never blocking a request
on the network.

### Attribution

DB-IP Lite is licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Where you disclose
the lookup (for example your privacy policy), include:
`IP Geolocation by <a href="https://db-ip.com">DB-IP</a>`.

## Rules

```ts
import { DEFAULT_CONSENT_RULES, OPT_IN_REQUIRED_COUNTRIES } from '@absolutejs/consent';

DEFAULT_CONSENT_RULES; // { fallback: 'opt-in', optOutCountries: ['US'] }
```

`OPT_IN_REQUIRED_COUNTRIES` (EEA + GB + CH) is exported for apps that choose
the inverse policy: opt-out everywhere except those countries.

## License

BSL 1.1 — see [LICENSE](./LICENSE).
