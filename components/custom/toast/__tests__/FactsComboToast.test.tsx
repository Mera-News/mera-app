/**
 * The "Updating all facts" progress toast is driven by the DATABASE, not by an
 * in-memory flag: it shows while any topic_combo job is pending or running,
 * closes at zero, and comes back after a relaunch that finds jobs still queued.
 * The job count is faked with a Subject standing in for WatermelonDB's
 * observeCount().
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { BehaviorSubject } from 'rxjs';

let mockCount: BehaviorSubject<number>;

jest.mock('../facts-combo-source', () => ({
    observeActiveComboJobCount: () => mockCount.asObservable(),
}));

jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const R = require('react');
    return {
        __esModule: true,
        default: { View: R.forwardRef((p: any, ref: any) => R.createElement(View, { ...p, ref })) },
        Easing: { linear: 'linear' },
        useSharedValue: (initial: number) => {
            const { useRef } = require('react');
            return useRef({ value: initial }).current;
        },
        useAnimatedStyle: (fn: () => unknown) => fn(),
        useReducedMotion: () => false,
        withRepeat: (v: unknown) => v,
        withTiming: (v: unknown) => v,
        cancelAnimation: () => undefined,
    };
});

jest.mock('@/components/ui/toast', () => {
    const R = require('react');
    const { View, Text } = require('react-native');
    return {
        Toast: (p: any) => R.createElement(View, null, p.children),
        ToastTitle: (p: any) => R.createElement(Text, null, p.children),
        ToastDescription: (p: any) => R.createElement(Text, null, p.children),
    };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), captureException: jest.fn() },
}));

import FactsComboToast, { FACTS_COMBO_TOAST_ID } from '../FactsComboToast';
import { closeAll, isActive, resetToastQueue, show, useToastQueue } from '@/lib/toast/toast-queue';

const entry = () => useToastQueue.getState().entries.find((e) => e.id === FACTS_COMBO_TOAST_ID);

beforeEach(() => {
    jest.useFakeTimers();
    resetToastQueue();
    mockCount = new BehaviorSubject(0);
});

afterEach(() => {
    act(() => closeAll());
    jest.useRealTimers();
});

describe('FactsComboToast', () => {
    it('shows nothing while no combo job is queued', () => {
        render(<FactsComboToast />);
        expect(isActive(FACTS_COMBO_TOAST_ID)).toBe(false);
    });

    it('shows a persistent, non-dismissible card while the count is above 0, and closes it at 0', () => {
        render(<FactsComboToast />);
        act(() => mockCount.next(3));
        const card = entry();
        expect(card).toBeTruthy();
        expect(card?.duration).toBeNull();
        expect(card?.dismissible).toBe(false);

        act(() => mockCount.next(0));
        expect(isActive(FACTS_COMBO_TOAST_ID)).toBe(false);
    });

    it('never re-shows the card while the count merely changes, so its title is not re-announced', () => {
        render(<FactsComboToast />);
        act(() => mockCount.next(3));
        const first = entry();
        act(() => mockCount.next(2));
        act(() => mockCount.next(1));
        // Same card object: a re-show would mint a new entry (and move it back).
        expect(entry()).toBe(first);
    });

    it('stays behind ordinary toasts, which pass in front of it', () => {
        render(<FactsComboToast />);
        act(() => mockCount.next(1));
        let transient = '';
        act(() => {
            transient = show({ duration: 5000, render: () => null });
        });
        expect(useToastQueue.getState().entries.map((e) => e.id)).toEqual([transient, FACTS_COMBO_TOAST_ID]);
    });

    it('shows again after a relaunch that finds jobs still pending', () => {
        const first = render(<FactsComboToast />);
        act(() => mockCount.next(2));
        expect(isActive(FACTS_COMBO_TOAST_ID)).toBe(true);

        // Relaunch: the JS world starts over, the rows are still in the DB.
        first.unmount();
        act(() => resetToastQueue());
        mockCount = new BehaviorSubject(2);
        render(<FactsComboToast />);
        expect(isActive(FACTS_COMBO_TOAST_ID)).toBe(true);
    });

    it('renders the stable title, the small subtitle and the bar', () => {
        render(<FactsComboToast />);
        act(() => mockCount.next(1));
        const card = entry();
        const body = render(<>{card?.render({ id: FACTS_COMBO_TOAST_ID })}</>);
        expect(body.getByText('profile.updatingAllFacts')).toBeTruthy();
        expect(body.getByText('profile.pleaseWait')).toBeTruthy();
        expect(body.getByTestId('facts-combo-progress', { includeHiddenElements: true })).toBeTruthy();
    });
});
