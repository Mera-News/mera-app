import { registerStatusCard, resetStatusCard, statusIconTap, tapStatusIcon, useFeedStatusCard } from '../feed-status-card';

describe('statusIconTap', () => {
    it('an open card: nothing but a scroll', () => {
        expect(statusIconTap('open')).toBe('scroll');
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
        useFeedStatusCard.setState({ requested: false, expanded: true, mounted: 0, scrollSignal: 0 });
    });

    it('with no card mounted, requests one, open, and scrolls', () => {
        tapStatusIcon();
        expect(useFeedStatusCard.getState()).toMatchObject({ requested: true, expanded: true, scrollSignal: 1 });
    });

    it('with a collapsed card mounted, expands it and never requests a second', () => {
        const unregister = registerStatusCard();
        useFeedStatusCard.setState({ expanded: false });
        tapStatusIcon();
        expect(useFeedStatusCard.getState()).toMatchObject({ requested: false, expanded: true, scrollSignal: 1 });
        unregister();
    });

    it('leaving the page drops a requested card', () => {
        tapStatusIcon();
        resetStatusCard();
        expect(useFeedStatusCard.getState().requested).toBe(false);
    });
});
