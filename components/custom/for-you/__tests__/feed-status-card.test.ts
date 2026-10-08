import { registerStatusCard, resetStatusCard, statusIconTap, tapStatusIcon, useFeedStatusCard } from '../feed-status-card';

describe('statusIconTap', () => {
    it('an open card: only reveal the header', () => {
        expect(statusIconTap('open')).toBe('reveal');
    });
    it('a collapsed card: expand it', () => {
        expect(statusIconTap('collapsed')).toBe('expand');
    });
    it('no card: show one', () => {
        expect(statusIconTap('absent')).toBe('show');
    });
});

describe('tapStatusIcon', () => {
    beforeEach(() => {
        useFeedStatusCard.setState({ requested: false, expanded: true, mounted: 0, emptyWants: false, revealSignal: 0 });
    });

    it('with no card mounted, requests one, open, and reveals the header', () => {
        tapStatusIcon();
        expect(useFeedStatusCard.getState()).toMatchObject({ requested: true, expanded: true, revealSignal: 1 });
    });

    it('with a collapsed card mounted, expands it and never requests a second', () => {
        const unregister = registerStatusCard();
        useFeedStatusCard.setState({ expanded: false });
        tapStatusIcon();
        expect(useFeedStatusCard.getState()).toMatchObject({ requested: false, expanded: true, revealSignal: 1 });
        unregister();
    });

    it('leaving the page drops a requested card', () => {
        tapStatusIcon();
        resetStatusCard();
        expect(useFeedStatusCard.getState().requested).toBe(false);
    });
});
