import { actionDisplay, isRevertible, sourceLabelKey } from '../action-display';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';

describe('persona-audit action-display', () => {
    it('maps every known action_type to a distinct label key', () => {
        const values = Object.values(ACTION_NAMES);
        for (const actionType of values) {
            const d = actionDisplay(actionType);
            expect(d.icon).toBeTruthy();
            expect(d.labelKey).toBeTruthy();
            expect(d.labelKey).not.toBe('unknown');
        }
    });

    it('falls back to a history icon for an unknown action_type', () => {
        const d = actionDisplay('some_future_action');
        expect(d.icon).toBe('history');
        expect(d.labelKey).toBe('unknown');
    });

    it('treats every action except revert_change as revertible', () => {
        expect(isRevertible(ACTION_NAMES.SET_TOPIC_WEIGHT)).toBe(true);
        expect(isRevertible(ACTION_NAMES.ADD_TOPIC)).toBe(true);
        expect(isRevertible(ACTION_NAMES.REVERT_CHANGE)).toBe(false);
    });

    it('maps known sources to their own key and unknown to "unknown"', () => {
        expect(sourceLabelKey('user')).toBe('user');
        expect(sourceLabelKey('migration')).toBe('migration');
        expect(sourceLabelKey('mystery')).toBe('unknown');
    });
});
