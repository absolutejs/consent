import { describe, expect, test } from 'bun:test';
import { createConsentStore, readGpc, resolveRegion } from '../src';
import type { ConsentStorage } from '../src';

const memory = () => {
	const items = new Map<string, string>();
	const storage: ConsentStorage = {
		getItem: (key) => items.get(key) ?? null,
		removeItem: (key) => {
			items.delete(key);
		},
		setItem: (key, value) => {
			items.set(key, value);
		}
	};

	return { items, storage };
};
const categories = ['analytics', 'marketing'] as const;
const us = resolveRegion({ country: 'US' });
const eu = resolveRegion({ country: 'DE' });

describe('defaults by regime', () => {
	test('opt-in regions start denied and ask', () => {
		const store = createConsentStore({
			categories,
			region: eu,
			storage: null
		});
		expect(store.getState()).toMatchObject({
			choices: { analytics: false, marketing: false },
			decided: false,
			needsNotice: false,
			needsPrompt: true
		});
	});
	test('opt-out regions start granted with a notice', () => {
		const store = createConsentStore({
			categories,
			region: us,
			storage: null
		});
		expect(store.getState()).toMatchObject({
			choices: { analytics: true, marketing: true },
			needsNotice: true,
			needsPrompt: false
		});
	});
	test('GPC turns opt-out defaults off for the configured categories', () => {
		const store = createConsentStore({
			categories,
			gpc: true,
			gpcCategories: ['marketing'],
			region: us,
			storage: null
		});
		expect(store.getState().choices).toEqual({
			analytics: true,
			marketing: false
		});
		const strict = createConsentStore({
			categories,
			gpc: true,
			region: us,
			storage: null
		});
		expect(strict.getState().choices).toEqual({
			analytics: false,
			marketing: false
		});
	});
	test('an explicit choice overrides GPC', () => {
		const store = createConsentStore({
			categories,
			gpc: true,
			region: us,
			storage: null
		});
		store.decide({ analytics: true });
		expect(store.getState().choices).toEqual({
			analytics: true,
			marketing: false
		});
	});
});

describe('decisions', () => {
	test('persist and survive a reload', () => {
		const { storage } = memory();
		const first = createConsentStore({
			categories,
			now: () => 5,
			region: eu,
			storage
		});
		first.decide({ analytics: true });
		const second = createConsentStore({ categories, region: eu, storage });
		expect(second.getState()).toMatchObject({
			choices: { analytics: true, marketing: false },
			decided: true,
			decidedAt: 5,
			needsPrompt: false
		});
	});
	test('a region change only moves undecided defaults', () => {
		const store = createConsentStore({
			categories,
			region: us,
			storage: null
		});
		store.setRegion(eu);
		expect(store.getState().choices.analytics).toBe(false);
		store.acceptAll();
		store.setRegion(us);
		store.setRegion(eu);
		expect(store.getState().choices.analytics).toBe(true);
	});
	test('dismissing the notice keeps defaults and records no decision', () => {
		const { storage } = memory();
		const store = createConsentStore({ categories, region: us, storage });
		store.dismissNotice();
		const reloaded = createConsentStore({
			categories,
			region: us,
			storage
		});
		expect(reloaded.getState()).toMatchObject({
			choices: { analytics: true },
			decided: false,
			needsNotice: false
		});
		reloaded.setRegion(eu);
		expect(reloaded.getState()).toMatchObject({
			choices: { analytics: false },
			needsPrompt: true
		});
	});
	test('subscribers hear every change and can unsubscribe', () => {
		const store = createConsentStore({
			categories,
			region: eu,
			storage: null
		});
		const seen: boolean[] = [];
		const stop = store.subscribe((state) =>
			seen.push(state.choices.analytics)
		);
		store.acceptAll();
		store.rejectAll();
		stop();
		store.acceptAll();
		expect(seen).toEqual([true, false]);
	});
	test('clear restores region defaults', () => {
		const { items, storage } = memory();
		const store = createConsentStore({ categories, region: eu, storage });
		store.acceptAll();
		store.clear();
		expect(items.size).toBe(0);
		expect(store.getState().needsPrompt).toBe(true);
	});
});

describe('remote (account) decisions', () => {
	test('a newer account decision applies on a new device', () => {
		const store = createConsentStore({
			categories,
			region: eu,
			storage: null
		});
		expect(
			store.applyRemote({ choices: { analytics: true }, decidedAt: 10 })
		).toBe(true);
		expect(store.getState()).toMatchObject({
			choices: { analytics: true, marketing: false },
			decided: true
		});
	});
	test('an older account decision never overwrites a newer local one', () => {
		let clock = 20;
		const store = createConsentStore({
			categories,
			now: () => clock,
			region: eu,
			storage: null
		});
		store.rejectAll();
		expect(
			store.applyRemote({ choices: { analytics: true }, decidedAt: 10 })
		).toBe(false);
		expect(store.getState().choices.analytics).toBe(false);
		clock = 30;
		expect(
			store.applyRemote({ choices: { analytics: true }, decidedAt: 25 })
		).toBe(true);
	});
});

describe('storage robustness', () => {
	test('corrupt or foreign values fall back to defaults', () => {
		const { items, storage } = memory();
		items.set('absolute-consent', '{not json');
		expect(
			createConsentStore({ categories, region: eu, storage }).getState()
				.decided
		).toBe(false);
		items.set(
			'absolute-consent',
			JSON.stringify({
				version: 2,
				decision: { choices: { analytics: 'yes' }, decidedAt: 1 }
			})
		);
		expect(
			createConsentStore({ categories, region: eu, storage }).getState()
				.choices.analytics
		).toBe(false);
	});
	test('migrate reads an earlier format', () => {
		const { items, storage } = memory();
		items.set(
			'legacy',
			JSON.stringify({ analytics: true, marketing: false, version: 1 })
		);
		const store = createConsentStore({
			categories,
			migrate: (raw) =>
				typeof raw === 'object' &&
				raw !== null &&
				'analytics' in raw &&
				typeof raw.analytics === 'boolean'
					? { choices: { analytics: raw.analytics }, decidedAt: 0 }
					: null,
			region: eu,
			storage,
			storageKey: 'legacy'
		});
		expect(store.getState()).toMatchObject({
			choices: { analytics: true },
			decided: true
		});
	});
	test('throwing storage never breaks the store', () => {
		const storage: ConsentStorage = {
			getItem: () => {
				throw new Error('blocked');
			},
			removeItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			}
		};
		const store = createConsentStore({ categories, region: eu, storage });
		store.acceptAll();
		store.clear();
		expect(store.getState().decided).toBe(false);
	});
});

test('readGpc', () => {
	expect(readGpc({ globalPrivacyControl: true })).toBe(true);
	expect(readGpc({ globalPrivacyControl: 'true' })).toBe(false);
	expect(readGpc({})).toBe(false);
});
