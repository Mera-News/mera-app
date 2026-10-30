import { BEAT_MS, layout, minBeatsFor, ramp, totalMs, wordCount } from '@/tutorials/film/timeline';

describe('film timeline', () => {
    it('puts every cut on a beat', () => {
        const spans = layout([{ id: 'a', beats: 8 }, { id: 'b', beats: 7 }, { id: 'c', beats: 11 }]);
        expect(spans.map((s) => s.start)).toEqual([0, 8 * BEAT_MS, 15 * BEAT_MS]);
        expect(totalMs(spans)).toBe(26 * BEAT_MS);
        for (const s of spans) expect((s.start / BEAT_MS) % 1).toBe(0);
    });

    it('asks for more beats as the copy grows', () => {
        expect(minBeatsFor(15)).toBe(9);
        expect(minBeatsFor(3)).toBeLessThan(minBeatsFor(15));
        expect(wordCount('Ready? Let’s start', 'No wrong answers.')).toBe(6);
    });

    it('ramps from 0 to 1, strictly rising', () => {
        const { inputRange, outputRange } = ramp(1000, 300);
        expect(inputRange[0]).toBe(1000);
        expect(inputRange[inputRange.length - 1]).toBe(1300);
        expect(outputRange[0]).toBe(0);
        expect(outputRange[outputRange.length - 1]).toBe(1);
        for (let i = 1; i < outputRange.length; i++) expect(outputRange[i]).toBeGreaterThan(outputRange[i - 1]);
    });
});
