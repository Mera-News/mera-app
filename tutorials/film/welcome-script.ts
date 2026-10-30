// The welcome film's script: the scenes on the beat grid and the copy keys it
// reads. Pure, so tests and the video export read it too. Copy is ELI10 (owner)
// and lives under `tutorials.chapters.welcome.film`; `<a>…</a>` marks the
// accented words of a caption.

import { layout, type SceneSpan } from './timeline';

const F = 'tutorials.chapters.welcome.film';

const CAPTIONS = ['noise', 'you', 'tell', 'becomes', 'haystack', 'picks', 'reads', 'why', 'private'] as const;
const FACTS = ['nurse', 'utrecht', 'kids', 'cycle', 'psv', 'spanish', 'rent', 'funds', 'porto', 'veg', 'piano', 'japan'] as const;
const TOPICS = ['nursePay', 'staffing', 'nightShift', 'housing', 'council', 'holidays', 'bikeLanes', 'railStrikes', 'eredivisie', 'languageApps', 'rentRules', 'energyBills', 'interestRates', 'portoFlights', 'foodPrices', 'concerts', 'japanTravel', 'yenRate'] as const;
const PILLS = ['trending', 'fake', 'screenTime', 'rage'] as const;
const MISC = ['healthDesk', 'cityNews', 'celebNews', 'markets', 'education', 'high', 'med'] as const;

type Group<T extends readonly string[]> = Record<T[number], string>;
export interface WelcomeCopy {
    readonly cap: Group<typeof CAPTIONS>;
    readonly fact: Group<typeof FACTS>;
    readonly topic: Group<typeof TOPICS>;
    readonly pill: Group<typeof PILLS>;
    readonly misc: Group<typeof MISC>;
}

const GROUPS = { cap: CAPTIONS, fact: FACTS, topic: TOPICS, pill: PILLS, misc: MISC } as const;

/** Every key the film reads, for the contract test and the dictionaries. */
export const WELCOME_COPY_KEYS: string[] = Object.entries(GROUPS).flatMap(([g, ids]) => ids.map((id) => `${F}.${g}.${id}`));

export function resolveWelcomeCopy(lookup: (key: string) => string): WelcomeCopy {
    const out = {} as Record<string, Record<string, string>>;
    for (const [g, ids] of Object.entries(GROUPS)) {
        out[g] = {};
        for (const id of ids) out[g][id] = lookup(`${F}.${g}.${id}`);
    }
    return out as unknown as WelcomeCopy;
}

export type WelcomeSceneId = 'noise' | 'you' | 'tell' | 'private' | 'becomes' | 'haystack' | 'picks' | 'reads' | 'notes' | 'foryou' | 'logo';

/** Beats per scene at the timeline's BPM; each holds its English copy at 0.3 s a word (test). */
export const SCENE_BEATS: Record<WelcomeSceneId, number> = {
    noise: 6, you: 5, tell: 5, private: 6, becomes: 8, haystack: 9, picks: 6, reads: 8, notes: 6, foryou: 6, logo: 6,
};

/** The film, start to finish: the in-app tour and the exported video are the same film. */
export const WELCOME_SPANS = layout((Object.keys(SCENE_BEATS) as WelcomeSceneId[]).map((id) => ({ id, beats: SCENE_BEATS[id] }))) as (SceneSpan & { id: WelcomeSceneId })[];

export function startOf(id: WelcomeSceneId): number {
    const span = WELCOME_SPANS.find((x) => x.id === id);
    if (!span) throw new Error(`no scene ${id}`);
    return span.start;
}

const plain = (s: string) => s.replace(/<\/?a>/g, '');

/** The lines a viewer must read while a caption is up (a caption shared by two scenes counts once, on the first). */
export function sceneLines(id: WelcomeSceneId, c: WelcomeCopy): string[] {
    switch (id) {
        case 'noise': return [plain(c.cap.noise)];
        case 'you': return [plain(c.cap.you)];
        case 'tell': return [plain(c.cap.tell)];
        case 'becomes': return [plain(c.cap.becomes)];
        case 'haystack': return [plain(c.cap.haystack)];
        case 'picks': return [plain(c.cap.picks)];
        case 'reads': return [plain(c.cap.reads)];
        case 'notes': return [plain(c.cap.why)];
        case 'private': return [plain(c.cap.private)];
        default: return [];
    }
}
