/* eslint-disable @typescript-eslint/no-require-imports */
import {
    headerTitleLineHeight,
    headerTitleSize,
    HEADER_TITLE_MIN_SCALE,
} from '@/lib/typography/header-title-size';

describe('headerTitleSize', () => {
    // The bug this exists for: at a fixed 4xl the Dashboard title shared its row
    // with the status mark, the filter chip and the bell, ran out of width, and
    // truncated to "Dasbo…".
    it('steps down on a compact phone', () => {
        expect(headerTitleSize(320)).toBe('3xl'); // iPhone SE
        expect(headerTitleSize(390)).toBe('3xl'); // iPhone 15/16/17
        expect(headerTitleSize(399)).toBe('3xl');
    });

    it('keeps the display size where there is room', () => {
        expect(headerTitleSize(400)).toBe('4xl');
        expect(headerTitleSize(430)).toBe('4xl'); // Pro Max
        expect(headerTitleSize(1024)).toBe('4xl'); // tablet
    });

    it('is a step function, never an interpolation', () => {
        // Deliberate: every step of the type scale carries a matched lineHeight,
        // and a size between steps would not. That is what clips Devanagari
        // matras and Thai upper vowels.
        const sizes = new Set(
            [200, 320, 375, 390, 400, 430, 768, 1366].map(headerTitleSize),
        );
        expect([...sizes].sort()).toEqual(['3xl', '4xl']);
    });

    it('degrades sanely on a nonsense width rather than throwing', () => {
        // `useWindowDimensions` reports 0 for a frame before layout on some
        // Android launches; a title that throws there takes the screen with it.
        expect(headerTitleSize(0)).toBe('3xl');
        expect(headerTitleSize(-1)).toBe('3xl');
        expect(headerTitleSize(Number.NaN)).toBe('3xl');
    });

    it('leaves a floor that is still legibly a title', () => {
        // 0.75 of 3xl (30px) is 22.5px. Below this the title stops being a
        // title, so it ellipsises instead — the less bad of the two failures.
        expect(HEADER_TITLE_MIN_SCALE).toBeGreaterThanOrEqual(0.7);
        expect(HEADER_TITLE_MIN_SCALE).toBeLessThan(1);
        expect(30 * HEADER_TITLE_MIN_SCALE).toBeGreaterThanOrEqual(22);
    });
});

describe('headerTitleLineHeight', () => {
    // READ FROM THE TYPE SCALE, not hardcoded in the assertion. A literal 54
    // here would keep passing after someone retunes the scale, and the header
    // row would then be pinned to a height the title no longer occupies —
    // which is a clipped title, silently, on every phone.
    const scale = require('@/tailwind.config.js').theme.extend.fontSize as Record<
        string,
        [string, { lineHeight: string }]
    >;
    const lineHeightOf = (token: '3xl' | '4xl') => parseInt(scale[token][1].lineHeight, 10);

    it('the type scale still declares a matched lineHeight for both steps', () => {
        // The positive control for the two assertions below: if this shape ever
        // changes, they must fail loudly rather than compare against NaN.
        expect(Number.isFinite(lineHeightOf('3xl'))).toBe(true);
        expect(Number.isFinite(lineHeightOf('4xl'))).toBe(true);
        expect(lineHeightOf('4xl')).toBeGreaterThan(lineHeightOf('3xl'));
    });

    it('returns the live lineHeight of whichever step the width selects', () => {
        expect(headerTitleLineHeight(320)).toBe(lineHeightOf('3xl'));
        expect(headerTitleLineHeight(390)).toBe(lineHeightOf('3xl'));
        expect(headerTitleLineHeight(430)).toBe(lineHeightOf('4xl'));
        expect(headerTitleLineHeight(1024)).toBe(lineHeightOf('4xl'));
    });

    it('breaks at the SAME width as headerTitleSize, from one breakpoint', () => {
        // Two copies of the breakpoint is how the pin and the title drift apart
        // on the one device that sits between them.
        for (const w of [0, 320, 375, 390, 399, 400, 402, 414, 430, 768, 1024]) {
            expect(headerTitleLineHeight(w)).toBe(lineHeightOf(headerTitleSize(w)));
        }
    });

    it('degrades sanely on a nonsense width, like its sibling', () => {
        expect(headerTitleLineHeight(0)).toBe(lineHeightOf('3xl'));
        expect(headerTitleLineHeight(Number.NaN)).toBe(lineHeightOf('3xl'));
    });

    it('leaves room for the two-line narration box at every step', () => {
        // 2 x 21 = 42. If the pin ever drops below that the narration clips
        // instead of the row growing, because the row height is fixed.
        const {
            HEADER_NARRATION_METRICS,
        } = require('@/components/custom/for-you/header-narration');
        const needed =
            HEADER_NARRATION_METRICS.lineHeight * HEADER_NARRATION_METRICS.maxLines;
        expect(headerTitleLineHeight(320)).toBeGreaterThanOrEqual(needed);
        expect(headerTitleLineHeight(430)).toBeGreaterThanOrEqual(needed);
    });
});
