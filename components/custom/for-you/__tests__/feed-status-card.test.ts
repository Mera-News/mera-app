import { resetStatusCard, setEmptyWantsCard, statsCardShown, useFeedStatusCard } from '../feed-status-card';

describe('the counts card state', () => {
    beforeEach(() => {
        useFeedStatusCard.setState({ expanded: false, emptyWants: false });
    });

    it('an empty Feed opens the card; leaving collapses it', () => {
        setEmptyWantsCard(true);
        expect(useFeedStatusCard.getState().expanded).toBe(true);
        resetStatusCard();
        expect(useFeedStatusCard.getState().expanded).toBe(false);
    });

    it('the first suggestions fold an empty Feed card back', () => {
        setEmptyWantsCard(true);
        setEmptyWantsCard(false);
        expect(useFeedStatusCard.getState().expanded).toBe(false);
    });
});

describe('statsCardShown', () => {
    const none = { limited: false, emptyWants: false, hasRows: false };
    it('leads the list with suggestions, an empty Feed past a run, or the limit', () => {
        expect(statsCardShown(none)).toBe(false);
        for (const k of ['limited', 'emptyWants', 'hasRows'] as const) {
            expect(statsCardShown({ ...none, [k]: true })).toBe(true);
        }
    });
});
