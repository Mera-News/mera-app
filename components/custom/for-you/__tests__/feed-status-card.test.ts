import { resetStatusCard, setStatusCardExpanded, statsCardShown, useFeedStatusCard } from '../feed-status-card';

describe('the counts card state', () => {
    it('starts collapsed; only a tap opens it, and leaving folds it', () => {
        expect(useFeedStatusCard.getState().expanded).toBe(false);
        setStatusCardExpanded(true);
        expect(useFeedStatusCard.getState().expanded).toBe(true);
        resetStatusCard();
        expect(useFeedStatusCard.getState().expanded).toBe(false);
    });
});

describe('statsCardShown', () => {
    const none = { limited: false, empty: false, hasRows: false };
    it('leads the list with suggestions, an empty Feed past a run, or the limit', () => {
        expect(statsCardShown(none)).toBe(false);
        for (const k of ['limited', 'empty', 'hasRows'] as const) {
            expect(statsCardShown({ ...none, [k]: true })).toBe(true);
        }
    });
});
