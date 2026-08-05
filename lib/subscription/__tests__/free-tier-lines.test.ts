// free-tier-lines.test.ts — Mera must never assert data the user does not have.
//
// Two of the lines describe the user's own content ("the articles you saved are
// still saved", "the stories you follow keep everything they've collected").
// Both are lies for a user with none, and both read as reassuring right up until
// the user notices they own nothing of the kind. This suite pins that they only
// appear when the on-device count is genuinely non-zero.

import {
    freeTierLineKeys,
    UNCONDITIONAL_LINE_KEYS,
} from '../free-tier-lines';

const SAVED = 'freeTier.meraLines.savedStay';
const FOLLOWED = 'freeTier.meraLines.followedKeep';

describe('freeTierLineKeys', () => {
    it('omits BOTH state-dependent lines when the device holds neither', () => {
        const keys = freeTierLineKeys({ savedCount: 0, trackedCount: 0 });
        expect(keys).not.toContain(SAVED);
        expect(keys).not.toContain(FOLLOWED);
    });

    it('includes the saved line only once something is actually saved', () => {
        expect(freeTierLineKeys({ savedCount: 0, trackedCount: 3 })).not.toContain(SAVED);
        expect(freeTierLineKeys({ savedCount: 1, trackedCount: 3 })).toContain(SAVED);
    });

    it('includes the followed-stories line only once a story is actually followed', () => {
        expect(freeTierLineKeys({ savedCount: 9, trackedCount: 0 })).not.toContain(FOLLOWED);
        expect(freeTierLineKeys({ savedCount: 9, trackedCount: 1 })).toContain(FOLLOWED);
    });

    it('always speaks every unconditional line, whatever the state', () => {
        for (const state of [
            { savedCount: 0, trackedCount: 0 },
            { savedCount: 5, trackedCount: 5 },
        ]) {
            const keys = freeTierLineKeys(state);
            for (const unconditional of UNCONDITIONAL_LINE_KEYS) {
                expect(keys).toContain(unconditional);
            }
        }
    });

    it('never returns an empty script — the bubble always has something true to say', () => {
        expect(freeTierLineKeys({ savedCount: 0, trackedCount: 0 }).length).toBeGreaterThan(0);
        expect(UNCONDITIONAL_LINE_KEYS.length).toBeGreaterThan(0);
    });

    // THE state to test is the ZERO state, not the populated one: a brand-new
    // first-open user has saved nothing and follows nothing, so both gated lines
    // drop out — and they are exactly the lines carrying the interleave. An
    // earlier ordering passed with counts of 1 and produced THREE consecutive
    // "I can't"s for every new user.
    it.each([
        ['nothing on the device', { savedCount: 0, trackedCount: 0 }],
        ['saved only', { savedCount: 4, trackedCount: 0 }],
        ['followed only', { savedCount: 0, trackedCount: 2 }],
        ['both', { savedCount: 4, trackedCount: 2 }],
    ])('never runs more than two "cannot" lines together — %s', (_label, state) => {
        const isCannot = freeTierLineKeys(state).map((k) => k.includes('cannot'));
        let run = 0;
        for (const cannot of isCannot) {
            run = cannot ? run + 1 : 0;
            expect(run).toBeLessThanOrEqual(2);
        }
    });

    it.each([
        ['nothing on the device', { savedCount: 0, trackedCount: 0 }],
        ['both', { savedCount: 4, trackedCount: 2 }],
    ])('opens and closes on something the user still has — %s', (_label, state) => {
        const keys = freeTierLineKeys(state);
        expect(keys[0]).not.toContain('cannot');
        expect(keys[keys.length - 1]).not.toContain('cannot');
    });

    it('ends on the way out, not on another absence', () => {
        const keys = freeTierLineKeys({ savedCount: 0, trackedCount: 0 });
        expect(keys[keys.length - 1]).toBe('freeTier.meraLines.planSwitchesMeOn');
    });

    it('every key it can emit exists in the English dictionary', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const en = require('@/lib/locales/en.json') as Record<string, any>;
        for (const key of freeTierLineKeys({ savedCount: 1, trackedCount: 1 })) {
            const value = key.split('.').reduce<any>((acc, part) => acc?.[part], en);
            expect(typeof value).toBe('string');
            expect((value as string).length).toBeGreaterThan(0);
        }
    });
});
