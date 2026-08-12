import {
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
