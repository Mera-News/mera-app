// The foreground gate: open at once when the app starts in the foreground (active, or iOS's inactive
// on the way there), closed on a background or unknown start until the first `active`. What waits
// behind it runs once, when it opens, in the same process.
import { setAppState } from '@/test/helpers';
import { appStateModule } from '@/test/helpers/app-state';
import {
    isForegroundGateOpen,
    resetForegroundGateForTests,
    whenForegroundGateOpens,
} from '@/lib/startup/foreground-gate';

const startIn = (state: string) => {
    appStateModule.currentState = state as never;
    resetForegroundGateForTests();
};

afterEach(() => startIn('active'));

describe.each(['active', 'inactive'])('a start read as %s', (state) => {
    it('opens at once and runs what waits on it straight away', () => {
        startIn(state);
        const held = jest.fn();
        whenForegroundGateOpens(held);
        expect(isForegroundGateOpen()).toBe(true);
        expect(held).toHaveBeenCalledTimes(1);
    });
});

describe.each(['background', 'unknown'])('a start read as %s', (state) => {
    it('stays closed until the first active, then runs each held step once', () => {
        startIn(state);
        const first = jest.fn();
        const second = jest.fn();
        whenForegroundGateOpens(first);
        whenForegroundGateOpens(second);
        setAppState('inactive');
        setAppState('background');
        expect(isForegroundGateOpen()).toBe(false);
        expect(first).not.toHaveBeenCalled();

        setAppState('active');
        setAppState('background');
        setAppState('active');
        expect(isForegroundGateOpen()).toBe(true);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('starts nothing when the app never comes to the foreground', () => {
        startIn(state);
        const held = jest.fn();
        whenForegroundGateOpens(held);
        setAppState('background');
        expect(held).not.toHaveBeenCalled();
    });
});

it('runs every held step even when one throws', () => {
    startIn('background');
    const after = jest.fn();
    whenForegroundGateOpens(() => {
        throw new Error('boom');
    });
    whenForegroundGateOpens(after);
    setAppState('active');
    expect(after).toHaveBeenCalledTimes(1);
});
