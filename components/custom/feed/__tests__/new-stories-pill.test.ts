import { pressNewStoriesPill } from '../new-stories-pill';

describe('pressNewStoriesPill', () => {
    it('hides the pill, then runs the pull-to-refresh path, and nothing else', () => {
        const calls: string[] = [];
        pressNewStoriesPill(
            () => calls.push('hide'),
            () => calls.push('refresh'),
        );
        expect(calls).toEqual(['hide', 'refresh']);
    });

    it('takes no list: it cannot scroll to an arrival, only refresh', () => {
        // The old handler took the list and called scrollToIndex on the first
        // arrival. The contract now has no way to reach the list at all.
        expect(pressNewStoriesPill.length).toBe(2);
    });
});
