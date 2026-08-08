import {
    animationIdFor,
    chapterSubtitleKey,
    chapterTitleKey,
    keysForSlide,
    lookupKey,
    slideAskKey,
    slideBodyKey,
    slideHeadlineKey,
} from '../keys';
import type { TutorialSlide } from '../types';

describe('key derivation', () => {
    it('builds chapter and slide keys from ids alone', () => {
        expect(chapterTitleKey('feed')).toBe('tutorials.chapters.feed.title');
        expect(chapterSubtitleKey('feed')).toBe('tutorials.chapters.feed.subtitle');
        expect(slideHeadlineKey('feed', 'two-lists')).toBe(
            'tutorials.chapters.feed.slides.two-lists.headline',
        );
        expect(slideBodyKey('feed', 'two-lists')).toBe(
            'tutorials.chapters.feed.slides.two-lists.body',
        );
        expect(slideAskKey('feed', 'two-lists')).toBe(
            'tutorials.chapters.feed.slides.two-lists.ask',
        );
    });

    it('derives the animation id the registry and the filename share', () => {
        expect(animationIdFor('privacy', 'stays-on-phone')).toBe(
            'privacy-stays-on-phone',
        );
    });
});

describe('keysForSlide', () => {
    const base = (extra: Partial<TutorialSlide>): TutorialSlide => ({
        id: 's1',
        visual: { placeholder: { kind: 'icon', name: 'lock' } },
        ...extra,
    });

    it('asks for the ask key only when the slide has the button', () => {
        expect(keysForSlide('feed', base({}))).not.toContain(
            'tutorials.chapters.feed.slides.s1.ask',
        );
        expect(keysForSlide('feed', base({ hasAsk: true }))).toContain(
            'tutorials.chapters.feed.slides.s1.ask',
        );
    });

    it('expands a steps placeholder into one key per row', () => {
        const keys = keysForSlide(
            'feed',
            base({ visual: { placeholder: { kind: 'steps', count: 3 } } }),
        );
        expect(keys).toContain('tutorials.chapters.feed.slides.s1.steps.0');
        expect(keys).toContain('tutorials.chapters.feed.slides.s1.steps.2');
        expect(keys).not.toContain('tutorials.chapters.feed.slides.s1.steps.3');
    });

    it('covers every interaction kind', () => {
        const reveal = keysForSlide(
            'feed',
            base({
                interaction: {
                    kind: 'tap-to-reveal',
                    targets: [{ id: 'a', icon: 'lock' }],
                },
            }),
        );
        expect(reveal).toContain('tutorials.chapters.feed.slides.s1.reveal.a.label');
        expect(reveal).toContain('tutorials.chapters.feed.slides.s1.reveal.a.text');

        const choose = keysForSlide(
            'feed',
            base({ interaction: { kind: 'choose', options: [{ id: 'x' }] } }),
        );
        expect(choose).toContain('tutorials.chapters.feed.slides.s1.choose.x.label');
        expect(choose).toContain('tutorials.chapters.feed.slides.s1.choose.x.feedback');

        const sort = keysForSlide(
            'feed',
            base({
                interaction: {
                    kind: 'sort',
                    cards: [{ id: 'c', bucketId: 'b' }],
                    buckets: [{ id: 'b', icon: 'lock' }],
                },
            }),
        );
        expect(sort).toContain('tutorials.chapters.feed.slides.s1.sort.cards.c');
        expect(sort).toContain('tutorials.chapters.feed.slides.s1.sort.buckets.b');

        const beforeAfter = keysForSlide(
            'feed',
            base({ interaction: { kind: 'before-after' } }),
        );
        expect(beforeAfter).toContain(
            'tutorials.chapters.feed.slides.s1.beforeAfter.before',
        );
        expect(beforeAfter).toContain(
            'tutorials.chapters.feed.slides.s1.beforeAfter.after',
        );
    });
});

describe('lookupKey', () => {
    const dict = { a: { b: { c: 'hit' } }, n: null, num: 3 };

    it('walks a dotted path to a string', () => {
        expect(lookupKey(dict, 'a.b.c')).toBe('hit');
    });

    it('returns undefined rather than throwing on a broken path', () => {
        // The interesting case: the path runs THROUGH a non-object. A naive
        // walker throws here, and a missing key must never crash the test that
        // exists to report missing keys.
        expect(lookupKey(dict, 'a.b.c.d')).toBeUndefined();
        expect(lookupKey(dict, 'n.anything')).toBeUndefined();
        expect(lookupKey(dict, 'num.toFixed')).toBeUndefined();
        expect(lookupKey(dict, 'nope')).toBeUndefined();
        expect(lookupKey(null, 'a')).toBeUndefined();
    });

    it('returns undefined for a node that is an object, not a string', () => {
        expect(lookupKey(dict, 'a.b')).toBeUndefined();
    });
});
