import { expect, test } from 'bun:test';
import { createConsentStore } from '../src/store';
import { resolveRegion } from '../src/regions';
test('defaults and old choices do not invent provenance', () => {
	const store = createConsentStore({
		categories: ['analytics'],
		region: resolveRegion({ country: 'US' }),
		storage: null
	});
	expect(store.getState().provenance).toBeUndefined();
	store.applyRemote({ choices: { analytics: false }, decidedAt: 1 });
	expect(store.getState().provenance).toBeUndefined();
	store.rejectAll();
	expect(store.getState().provenance?.source).toBe('reject-all');
	expect(store.getState().provenance?.region.country).toBe('US');
});
test('remote decisions preserve original provenance', () => {
	const a = createConsentStore({
		categories: ['analytics'],
		region: resolveRegion({ country: 'GB' }),
		storage: null,
		now: () => 10
	});
	a.acceptAll();
	const b = createConsentStore({
		categories: ['analytics'],
		region: resolveRegion({ country: 'US' }),
		storage: null
	});
	b.applyRemote({
		choices: a.getState().choices,
		decidedAt: 10,
		provenance: a.getState().provenance
	});
	expect(b.getState().provenance?.region.country).toBe('GB');
	expect(b.getState().provenance?.source).toBe('accept-all');
});
