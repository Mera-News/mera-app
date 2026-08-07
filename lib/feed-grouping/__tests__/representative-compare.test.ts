import {
    hasImage,
    makeRepCompare,
    type RepresentativeGroupItem,
    type RepresentativeSortable,
} from '../representative-compare';
import type { UserGeoLanguageContext } from '../geo-language-priority';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function s(over: Partial<RepresentativeSortable> & { _id: string }): RepresentativeSortable {
    return {
        firstPubDate: '2026-08-01T00:00:00.000Z',
        rawScore: 0.5,
        publication_name: null,
        country_code: null,
        language_code: null,
        image_url: null,
        ...over,
    };
}

const it_ = (over: Partial<RepresentativeSortable> & { _id: string }): RepresentativeGroupItem => ({
    s: s(over),
});

/** User: home = USA, other = GBR, app language en, prefers the Times of India
 *  and anything scoped to DEU. */
const CTX: UserGeoLanguageContext = {
    homeCountryAlpha3: 'USA',
    otherCountriesAlpha3: ['GBR'],
    appLanguageBase: 'en',
    preferredPublications: new Set(['times of india']),
    preferredCountriesAlpha3: new Set(['DEU']),
};

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

// ---------------------------------------------------------------------------
// Reference implementations
//
// `LEGACY` is the comparator as it stood BEFORE this change, copied verbatim
// from the two byte-identical originals in `lib/stores/feed-list-selector.ts`
// and `lib/stores/fact-rows-selector.ts` (both since deleted in favour of the
// shared module). It is retained here as the durable half of the extraction
// proof: the tier keys 1 and 2 were a pure move and MUST still agree with it.
// (The transient half — running both selectors' full suites against the
// extracted module with zero test edits — was done at extraction time.)
// ---------------------------------------------------------------------------

function parseMs(iso: string | null | undefined): number {
    if (!iso) return 0;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
}

function legacyRepCompare(a: RepresentativeGroupItem, b: RepresentativeGroupItem): number {
    const pa = parseMs(a.s.firstPubDate);
    const pb = parseMs(b.s.firstPubDate);
    if (pa !== pb) return pb - pa;
    const ra = a.s.rawScore ?? Number.NEGATIVE_INFINITY;
    const rb = b.s.rawScore ?? Number.NEGATIVE_INFINITY;
    if (ra !== rb) return rb - ra;
    return a.s._id < b.s._id ? -1 : a.s._id > b.s._id ? 1 : 0;
}

/** Independently-written reference for the NEW spec, expressed as a plain key
 *  vector rather than a chain of early returns — so a copy-paste slip in the
 *  implementation cannot reproduce itself here. */
function specKeys(
    x: RepresentativeGroupItem,
    ctx: UserGeoLanguageContext | null,
): (number | string)[] {
    // Source tier: 0 = named publication, 1 = named country scope, 2 = neither.
    const pub = (x.s.publication_name ?? '').trim().toLowerCase();
    const cc = (x.s.country_code ?? '').trim().toUpperCase();
    let source = 2;
    if (ctx?.preferredPublications?.has(pub)) source = 0;
    else if (cc !== '' && ctx?.preferredCountriesAlpha3?.has(cc)) source = 1;
    // Geo/language tier: 0 = home, 1 = other user country, 2 = app language,
    // 3 = rest.
    const lang = (x.s.language_code ?? '').split('-')[0].toLowerCase();
    let geo = 3;
    if (ctx && cc !== '' && cc === ctx.homeCountryAlpha3) geo = 0;
    else if (ctx && cc !== '' && ctx.otherCountriesAlpha3.includes(cc)) geo = 1;
    else if (ctx && lang !== '' && lang === ctx.appLanguageBase) geo = 2;
    return [
        source,
        geo,
        hasImage(x.s) ? 0 : 1,
        parseMs(x.s.firstPubDate),
        -(x.s.rawScore ?? Number.NEGATIVE_INFINITY),
        x.s._id,
    ];
}

function specCompare(ctx: UserGeoLanguageContext | null) {
    return (a: RepresentativeGroupItem, b: RepresentativeGroupItem): number => {
        const ka = specKeys(a, ctx);
        const kb = specKeys(b, ctx);
        for (let i = 0; i < ka.length; i += 1) {
            if (ka[i] === kb[i]) continue;
            if (typeof ka[i] === 'string') return (ka[i] as string) < (kb[i] as string) ? -1 : 1;
            return (ka[i] as number) - (kb[i] as number);
        }
        return 0;
    };
}

// ---------------------------------------------------------------------------

describe('hasImage', () => {
    it('is true only for a non-empty, non-blank image_url', () => {
        expect(hasImage(s({ _id: 'a', image_url: 'https://x/y.jpg' }))).toBe(true);
        expect(hasImage(s({ _id: 'a', image_url: null }))).toBe(false);
        expect(hasImage(s({ _id: 'a', image_url: '' }))).toBe(false);
        expect(hasImage(s({ _id: 'a', image_url: '   ' }))).toBe(false);
    });

    it('treats an absent image_url as no image (leaner projections stay legal)', () => {
        const bare = { _id: 'a', firstPubDate: null, rawScore: null, publication_name: null, country_code: null, language_code: null };
        expect(hasImage(bare)).toBe(false);
    });

    it('an insecure URL nulled at ingest is indistinguishable from no image — by design', () => {
        // A separate wave nulls non-https image URLs before they reach the app.
        // This asserts the resulting demotion is the intended behaviour, so a
        // future reader does not file it as a representative-election bug.
        const nulledAtIngest = s({ _id: 'a', image_url: null });
        const neverHadOne = s({ _id: 'b', image_url: null });
        expect(hasImage(nulledAtIngest)).toBe(hasImage(neverHadOne));
    });
});

describe('makeRepCompare — key order', () => {
    const cmp = makeRepCompare(CTX);

    it('sourcePriorityTier outranks the image key AND the date key', () => {
        const preferred = it_({
            _id: 'toi',
            publication_name: 'Times of India',
            country_code: 'IND',
            firstPubDate: '2026-08-05T00:00:00.000Z', // newest = worst on date
            image_url: null, // and no image
        });
        const rival = it_({
            _id: 'other',
            publication_name: 'Reuters',
            country_code: 'USA', // home country — best geo tier
            firstPubDate: '2026-08-01T00:00:00.000Z',
            image_url: 'https://x/y.jpg',
        });
        expect(sign(cmp(preferred, rival))).toBe(-1);
    });

    it('repPriorityTier outranks the image key AND the date key', () => {
        const home = it_({
            _id: 'home',
            country_code: 'USA',
            firstPubDate: '2026-08-05T00:00:00.000Z',
            image_url: null,
        });
        const foreign = it_({
            _id: 'foreign',
            country_code: 'FRA',
            firstPubDate: '2026-08-01T00:00:00.000Z',
            image_url: 'https://x/y.jpg',
        });
        expect(sign(cmp(home, foreign))).toBe(-1);
    });

    it('hasImage beats an OLDER article that has none', () => {
        const illustratedNewer = it_({ _id: 'img', firstPubDate: '2026-08-05T00:00:00.000Z', image_url: 'https://x/y.jpg' });
        const plainOlder = it_({ _id: 'plain', firstPubDate: '2026-08-01T00:00:00.000Z', image_url: null });
        expect(sign(cmp(illustratedNewer, plainOlder))).toBe(-1);
        expect(sign(cmp(plainOlder, illustratedNewer))).toBe(1);
    });

    it('with hasImage tied, the OLDER pubDate wins (the originating report)', () => {
        const older = it_({ _id: 'older', firstPubDate: '2026-08-01T00:00:00.000Z' });
        const newer = it_({ _id: 'newer', firstPubDate: '2026-08-05T00:00:00.000Z' });
        expect(sign(cmp(older, newer))).toBe(-1);
        // ...and this is the exact key the legacy comparator decided the other way.
        expect(sign(legacyRepCompare(older, newer))).toBe(1);
    });

    it('pubDate outranks rawScore (a higher-scoring newer member does NOT front)', () => {
        const older = it_({ _id: 'older', firstPubDate: '2026-08-01T00:00:00.000Z', rawScore: 0.1 });
        const newer = it_({ _id: 'newer', firstPubDate: '2026-08-05T00:00:00.000Z', rawScore: 0.9 });
        expect(sign(cmp(older, newer))).toBe(-1);
    });

    it('on a pure pubDate tie, higher rawScore then smaller _id decide', () => {
        const lo = it_({ _id: 'a', rawScore: 0.1 });
        const hi = it_({ _id: 'z', rawScore: 0.9 });
        expect(sign(cmp(hi, lo))).toBe(-1);
        const tiedA = it_({ _id: 'a', rawScore: 0.5 });
        const tiedZ = it_({ _id: 'z', rawScore: 0.5 });
        expect(sign(cmp(tiedA, tiedZ))).toBe(-1);
        expect(sign(cmp(tiedA, tiedA))).toBe(0);
    });

    it('a null rawScore ranks below any number, and an unparseable date parses to 0 (oldest ⇒ now WINS)', () => {
        const scored = it_({ _id: 'a', rawScore: 0 });
        const unscored = it_({ _id: 'b', rawScore: null });
        expect(sign(cmp(scored, unscored))).toBe(-1);
        const junkDate = it_({ _id: 'junk', firstPubDate: 'not-a-date' });
        const real = it_({ _id: 'real', firstPubDate: '2026-08-01T00:00:00.000Z' });
        // Deliberate consequence of the ASC flip: `parseMs` maps a bad/absent
        // date to 0, which used to sink such a row and now floats it. Recorded
        // so the behaviour is a decision, not an accident.
        expect(sign(cmp(junkDate, real))).toBe(-1);
        // Same story for an outright null date.
        const noDate = it_({ _id: 'nodate', firstPubDate: null });
        expect(sign(cmp(noDate, real))).toBe(-1);
    });

    it('a null userCtx collapses both tiers, leaving image → oldest → score → id', () => {
        const cmpNull = makeRepCompare(null);
        const usaNewer = it_({ _id: 'usa', country_code: 'USA', firstPubDate: '2026-08-05T00:00:00.000Z' });
        const fraOlder = it_({ _id: 'fra', country_code: 'FRA', firstPubDate: '2026-08-01T00:00:00.000Z' });
        expect(sign(cmpNull(fraOlder, usaNewer))).toBe(-1);
    });
});

// ---------------------------------------------------------------------------
// Extraction proof (durable half) + full-domain differential
// ---------------------------------------------------------------------------

/** A deterministic cross-product of every dimension the comparator reads. */
function corpus(): RepresentativeGroupItem[] {
    const out: RepresentativeGroupItem[] = [];
    const pubs = [null, 'Times of India', 'Reuters'];
    const countries = [null, 'USA', 'GBR', 'DEU', 'FRA'];
    const langs = [null, 'en', 'de'];
    const dates = ['2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z'];
    const images = [null, 'https://x/y.jpg'];
    const scores = [null, 0.2, 0.9];
    let n = 0;
    for (const publication_name of pubs)
        for (const country_code of countries)
            for (const language_code of langs)
                for (const firstPubDate of dates)
                    for (const image_url of images)
                        for (const rawScore of scores) {
                            n += 1;
                            out.push(
                                it_({
                                    _id: `i${String(n).padStart(4, '0')}`,
                                    publication_name,
                                    country_code,
                                    language_code,
                                    firstPubDate,
                                    image_url,
                                    rawScore,
                                }),
                            );
                        }
    return out;
}

describe('makeRepCompare — differential vs the legacy comparator (extraction proof)', () => {
    const items = corpus();

    for (const [label, ctx] of [
        ['with a full context', CTX],
        ['with a null context', null],
    ] as const) {
        it(`${label}: the TIER keys still decide exactly as they did before the change`, () => {
            // The tier keys were a PURE MOVE. Wherever the tiers separate two
            // items, the shared comparator must return the tier's verdict — the
            // new image/date keys must be unreachable. Anything the tiers tie is
            // out of scope for this assertion (that is where the spec changed).
            const cmp = makeRepCompare(ctx);
            const keys = items.map((x) => specKeys(x, ctx));
            const mismatches: string[] = [];
            let checked = 0;
            for (let i = 0; i < items.length; i += 1) {
                for (let j = 0; j < items.length; j += 1) {
                    const ka = keys[i];
                    const kb = keys[j];
                    if (ka[0] === kb[0] && ka[1] === kb[1]) continue; // tiers tied
                    const tierVerdict =
                        ka[0] !== kb[0] ? (ka[0] as number) - (kb[0] as number) : (ka[1] as number) - (kb[1] as number);
                    checked += 1;
                    if (sign(cmp(items[i], items[j])) !== sign(tierVerdict)) {
                        mismatches.push(`${items[i].s._id} vs ${items[j].s._id}`);
                    }
                }
            }
            expect(mismatches).toEqual([]);
            // A null context collapses every item to the same two tiers, so
            // there is nothing for this assertion to bite on — that IS the
            // documented fail-open behaviour, asserted directly below.
            if (ctx === null) expect(checked).toBe(0);
            else expect(checked).toBeGreaterThan(10_000);
        });

        it(`${label}: it matches an independent reference implementation of the new spec`, () => {
            const cmp = makeRepCompare(ctx);
            const ref = specCompare(ctx);
            const mismatches: string[] = [];
            for (const a of items) {
                for (const b of items) {
                    if (sign(cmp(a, b)) !== sign(ref(a, b))) {
                        mismatches.push(`${a.s._id} vs ${b.s._id}`);
                    }
                }
            }
            expect(mismatches).toEqual([]);
        });
    }

    it('legacy and new disagree ONLY where the new keys apply — proving the change is scoped', () => {
        const cmp = makeRepCompare(null);
        let disagreements = 0;
        const unexplained: string[] = [];
        for (const a of items) {
            for (const b of items) {
                if (sign(cmp(a, b)) === sign(legacyRepCompare(a, b))) continue;
                disagreements += 1;
                // Every disagreement must be attributable to the image key or to
                // the pubDate direction — never to rawScore or _id.
                const imageDiffers = hasImage(a.s) !== hasImage(b.s);
                const dateDiffers = parseMs(a.s.firstPubDate) !== parseMs(b.s.firstPubDate);
                if (!imageDiffers && !dateDiffers) unexplained.push(`${a.s._id} vs ${b.s._id}`);
            }
        }
        expect(unexplained).toEqual([]);
        expect(disagreements).toBeGreaterThan(0);
    });

    it('is a total order: sorting is stable, idempotent and input-order independent', () => {
        const cmp = makeRepCompare(CTX);
        const forward = [...items].sort(cmp).map((x) => x.s._id);
        const reversed = [...items].reverse().sort(cmp).map((x) => x.s._id);
        expect(reversed).toEqual(forward);
        const twice = [...items].sort(cmp).sort(cmp).map((x) => x.s._id);
        expect(twice).toEqual(forward);
        // Antisymmetry: no pair may claim mutual preference.
        const asymmetric: string[] = [];
        for (const a of items) {
            for (const b of items) {
                if (sign(cmp(a, b)) + sign(cmp(b, a)) !== 0) {
                    asymmetric.push(`${a.s._id} vs ${b.s._id}`);
                }
            }
        }
        expect(asymmetric).toEqual([]);
    });
});
