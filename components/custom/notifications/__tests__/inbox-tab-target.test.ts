import { inboxTabTarget } from '../inbox-tab-target';

describe('inboxTabTarget', () => {
    it('is the centre of the first tab (the Feed), above the inset', () => {
        expect(inboxTabTarget(400, 800, 34, 49, false)).toEqual({ x: 50, y: 800 - 34 - 24.5 });
    });

    it('mirrors to the last tab in RTL', () => {
        expect(inboxTabTarget(400, 800, 34, 49, true).x).toBe(350);
    });
});
