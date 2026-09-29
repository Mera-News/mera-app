// useTimeTickValue: a subscriber re-renders only when the value it derives
// from the shared clock changes. Every route change fires the clock, so a
// derived value that did not move must not cost a render.

import { act, renderHook } from '@testing-library/react-native';
import { __resetTimeTickForTests, notifyTimeTick, useTimeTickValue } from '../time-tick';

describe('useTimeTickValue', () => {
    let now = 1_000_000_000_000;

    beforeEach(() => {
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        __resetTimeTickForTests();
    });

    afterEach(() => {
        __resetTimeTickForTests();
        jest.restoreAllMocks();
    });

    function renderMinutes() {
        let renders = 0;
        const hook = renderHook(() => {
            renders += 1;
            return useTimeTickValue((t) => Math.floor(t / 60_000));
        });
        return { hook, renders: () => renders };
    }

    it('does NOT re-render when the clock moves but the derived value does not', () => {
        const { hook, renders } = renderMinutes();
        const before = renders();
        act(() => {
            now += 5_000; // same minute
            notifyTimeTick();
        });
        expect(renders()).toBe(before);
        expect(hook.result.current).toBe(Math.floor(now / 60_000));
    });

    it('re-renders with the new value when the derived value changes', () => {
        const { hook, renders } = renderMinutes();
        const before = renders();
        act(() => {
            now += 60_000; // next minute
            notifyTimeTick();
        });
        expect(renders()).toBeGreaterThan(before);
        expect(hook.result.current).toBe(Math.floor(now / 60_000));
    });
});
