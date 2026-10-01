import type { RegionResolution } from './regions';

export type ConsentChoices<Category extends string> = Record<Category, boolean>;

/** The subset of the Web Storage API the store needs. */
export type ConsentStorage = {
	getItem: (key: string) => string | null;
	removeItem: (key: string) => void;
	setItem: (key: string, value: string) => void;
};

export type ConsentDecision<Category extends string> = {
	choices: Partial<ConsentChoices<Category>>;
	/** Epoch milliseconds; the newer of a local and a remote decision wins. */
	decidedAt: number;
};

export type ConsentState<Category extends string> = {
	choices: ConsentChoices<Category>;
	/** True once the visitor (or their account) recorded an explicit choice. */
	decided: boolean;
	decidedAt: number | null;
	/** Browser Global Privacy Control signal. */
	gpc: boolean;
	/** Opt-out region, undecided: show a non-blocking notice with a way to
	 *  opt out. False after the visitor dismisses it. */
	needsNotice: boolean;
	/** Opt-in region, undecided: ask before anything optional runs. */
	needsPrompt: boolean;
	region: RegionResolution;
};

export type ConsentStoreOptions<Category extends string> = {
	categories: readonly Category[];
	gpc?: boolean;
	/** Categories a GPC signal turns off by default in opt-out regions.
	 *  Defaults to every category. */
	gpcCategories?: readonly Category[];
	/** Reads a decision persisted by an earlier storage format. */
	migrate?: (raw: unknown) => ConsentDecision<Category> | null;
	now?: () => number;
	region: RegionResolution;
	/** Pass null to keep decisions in memory only. */
	storage?: ConsentStorage | null;
	storageKey?: string;
};

type Persisted<Category extends string> = {
	decision: ConsentDecision<Category> | null;
	noticeAt: number | null;
};

type Listener<Category extends string> = (
	state: ConsentState<Category>
) => void;

const STORAGE_VERSION = 2;
const DEFAULT_STORAGE_KEY = 'absolute-consent';

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const defaultStorage = () => {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
};

export const createConsentStore = <Category extends string>({
	categories,
	gpc = false,
	gpcCategories = categories,
	migrate,
	now = Date.now,
	region,
	storage = defaultStorage(),
	storageKey = DEFAULT_STORAGE_KEY
}: ConsentStoreOptions<Category>) => {
	const pickChoices = (source: Record<string, unknown>) => {
		const picked: Partial<ConsentChoices<Category>> = {};
		for (const category of categories) {
			const value = source[category];
			if (typeof value === 'boolean') picked[category] = value;
		}

		return picked;
	};
	const parseDecision = (value: unknown) => {
		if (!isRecord(value) || typeof value.decidedAt !== 'number')
			return null;
		if (!isRecord(value.choices)) return null;
		const decision: ConsentDecision<Category> = {
			choices: pickChoices(value.choices),
			decidedAt: value.decidedAt
		};

		return decision;
	};
	const read = () => {
		const empty: Persisted<Category> = { decision: null, noticeAt: null };
		let raw: string | null;
		try {
			raw = storage?.getItem(storageKey) ?? null;
		} catch {
			return empty;
		}
		if (raw === null) return empty;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return empty;
		}
		if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION) {
			const migrated = migrate?.(parsed) ?? null;

			return { decision: migrated, noticeAt: null };
		}
		const persisted: Persisted<Category> = {
			decision: parseDecision(parsed.decision),
			noticeAt:
				typeof parsed.noticeAt === 'number' ? parsed.noticeAt : null
		};

		return persisted;
	};
	const write = (persisted: Persisted<Category>) => {
		try {
			storage?.setItem(
				storageKey,
				JSON.stringify({ ...persisted, version: STORAGE_VERSION })
			);
		} catch {
			// Storage blocked or full: the choice still applies for this page.
		}
	};

	let persisted = read();
	let currentRegion = region;
	let currentGpc = gpc;
	const listeners = new Set<Listener<Category>>();

	const defaults = () => {
		const choices: Partial<ConsentChoices<Category>> = {};
		for (const category of categories) {
			choices[category] =
				currentRegion.regime === 'opt-out' &&
				!(currentGpc && gpcCategories.includes(category));
		}

		return choices;
	};
	const isComplete = (
		choices: Partial<ConsentChoices<Category>>
	): choices is ConsentChoices<Category> =>
		categories.every((category) => typeof choices[category] === 'boolean');
	const compute = () => {
		const choices: Partial<ConsentChoices<Category>> = {
			...defaults(),
			...persisted.decision?.choices
		};
		if (!isComplete(choices))
			throw new Error('Consent defaults must cover every category.');
		const decided = persisted.decision !== null;
		const next: ConsentState<Category> = {
			choices,
			decided,
			decidedAt: persisted.decision?.decidedAt ?? null,
			gpc: currentGpc,
			needsNotice:
				!decided &&
				currentRegion.regime === 'opt-out' &&
				persisted.noticeAt === null,
			needsPrompt: !decided && currentRegion.regime === 'opt-in',
			region: currentRegion
		};

		return next;
	};

	let state = compute();
	const emit = () => {
		state = compute();
		for (const listener of listeners) listener(state);
	};
	const record = (decision: ConsentDecision<Category>) => {
		persisted = { ...persisted, decision };
		write(persisted);
		emit();
	};
	const all = (value: boolean) => {
		const choices: Partial<ConsentChoices<Category>> = {};
		for (const category of categories) choices[category] = value;

		return choices;
	};

	return {
		acceptAll: () => record({ choices: all(true), decidedAt: now() }),
		/** Merges a decision loaded from the visitor's account. Applied only
		 *  when it is newer than the local one; returns whether it was. */
		applyRemote: (decision: ConsentDecision<Category>) => {
			const local = persisted.decision?.decidedAt ?? -Infinity;
			if (decision.decidedAt <= local) return false;
			record({
				choices: { ...state.choices, ...pickChoices(decision.choices) },
				decidedAt: decision.decidedAt
			});

			return true;
		},
		/** Forgets the stored decision; defaults for the region apply again. */
		clear: () => {
			persisted = { decision: null, noticeAt: null };
			try {
				storage?.removeItem(storageKey);
			} catch {
				// Nothing persisted to remove.
			}
			emit();
		},
		/** Records an explicit choice. Unlisted categories keep their current
		 *  effective value. */
		decide: (choices: Partial<ConsentChoices<Category>>) =>
			record({
				choices: { ...state.choices, ...pickChoices(choices) },
				decidedAt: now()
			}),
		/** Hides the opt-out notice without recording a decision. */
		dismissNotice: () => {
			persisted = { ...persisted, noticeAt: now() };
			write(persisted);
			emit();
		},
		getState: () => state,
		rejectAll: () => record({ choices: all(false), decidedAt: now() }),
		setGpc: (value: boolean) => {
			currentGpc = value;
			emit();
		},
		/** Updates the region once a later lookup resolves it. A recorded
		 *  decision is unaffected; only undecided defaults change. */
		setRegion: (next: RegionResolution) => {
			currentRegion = next;
			emit();
		},
		subscribe: (listener: Listener<Category>) => {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		}
	};
};

export type ConsentStore<Category extends string> = ReturnType<
	typeof createConsentStore<Category>
>;

/** Reads `navigator.globalPrivacyControl`; false when unavailable (SSR). */
export const readGpc = (
	source: object | undefined = typeof navigator === 'undefined'
		? undefined
		: navigator
) =>
	source !== undefined &&
	'globalPrivacyControl' in source &&
	source.globalPrivacyControl === true;

/** The browser's IANA zone, or null when Intl cannot resolve one. */
export const readTimeZone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
	} catch {
		return null;
	}
};
