// TranslatableDynamic's on-screen states: English is the only fallback (pending and
// failed both show `text`, never the source language), a translating text shimmers, a
// failed one ends in a tappable slashed translate glyph whose tooltip says what to do,
// and the detail screen marks a machine translation with a plain glyph.
// The translation service is faked at its edge; the store, i18n and popover are real.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import TranslatableDynamic, { type TranslatableDisplayState } from '@/components/custom/TranslatableDynamic';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { initI18nEn } from '@/test/helpers';

// The preset's Modal mock loads an untransformed native spec; the popover opens through it.
jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return {
        __esModule: true,
        default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
            visible ? <View>{children}</View> : null,
    };
});

jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const { useRef } = require('react');
    return {
        __esModule: true,
        default: { View },
        Easing: require('react-native').Easing,
        // Per-instance identity, or every write is forgotten on the next render.
        useSharedValue: (v: unknown) => useRef({ value: v }).current,
        useAnimatedStyle: (fn: () => unknown) => fn(),
        cancelAnimation: () => {},
        withRepeat: (v: unknown) => v,
        withTiming: (v: unknown) => v,
    };
});

type Outcome = { status: 'ok' | 'failed' | 'dropped' | 'skipped'; text?: string };
let mockNextOutcome: () => Promise<Outcome>;
const mockTranslate = jest.fn((..._args: unknown[]) => mockNextOutcome());
let mockBlocked = false;
jest.mock('@/lib/translation-service', () => ({
    ...jest.requireActual('@/lib/translation-service'),
    translateTextDetailed: (...a: unknown[]) => mockTranslate(...a),
    useTranslationSuppressed: () => mockBlocked,
    useTranslationBlocked: () => (mockBlocked ? { blockedAt: 0 } : null),
}));

// The app is in front (the queue is not paused).
let mockQueueActive = true;
jest.mock('@/lib/translation-queue', () => {
    const { useEffect, useState } = require('react');
    return {
        ...jest.requireActual('@/lib/translation-queue'),
        useTranslationQueueActive: () => {
            const [, bump] = useState(0);
            useEffect(() => {
                const l = () => bump((n: number) => n + 1);
                mockGateListeners.add(l);
                return () => {
                    mockGateListeners.delete(l);
                };
            }, []);
            return mockQueueActive;
        },
    };
});

// The re-ask gate: is the reader looking at this text.
let mockGate = true;
const mockGateListeners = new Set<() => void>();
jest.mock('@/lib/hooks/use-is-focused-safe', () => {
    const { useEffect, useState } = require('react');
    return {
        ...jest.requireActual('@/lib/hooks/use-is-focused-safe'),
        useIsFocusedSafe: () => {
            const [, bump] = useState(0);
            useEffect(() => {
                const l = () => bump((n: number) => n + 1);
                mockGateListeners.add(l);
                return () => {
                    mockGateListeners.delete(l);
                };
            }, []);
            return mockGate;
        },
        useAnimationsActive: () => true,
    };
});
const setGate = (open: boolean) =>
    act(() => {
        mockGate = open;
        mockGateListeners.forEach((l) => l());
    });

// The RN jest preset's host nodes never answer measureInWindow: put every node on screen.
const MockNativeMethods = jest.requireActual('react-native/jest/MockNativeMethods').default;

const EN = 'Monsoon reaches Delhi';
const HI = 'दिल्ली पहुंचा मानसून';
const MR = 'मान्सून दिल्लीत';
const FAILED = 'Translation failed. Restart the app.';

const card = (extra: Partial<React.ComponentProps<typeof TranslatableDynamic>> = {}) => (
    <TranslatableDynamic text={EN} originalText={HI} originalLanguage="hi" numberOfLines={3} {...extra} />
);
const detail = (extra: Partial<React.ComponentProps<typeof TranslatableDynamic>> = {}) => (
    <TranslatableDynamic text={EN} originalText={HI} originalLanguage="hi" {...extra} />
);
const settle = () => act(async () => {});

beforeAll(initI18nEn);
beforeEach(() => {
    MockNativeMethods.measureInWindow.mockImplementation((cb: (...n: number[]) => void) => cb(0, 100, 300, 20));
    mockTranslate.mockClear();
    mockBlocked = false;
    mockGate = true;
    mockQueueActive = true;
    mockNextOutcome = () => new Promise(() => {});
    useAppLanguageStore.setState({ appLanguage: 'mr', cache: new Map(), pending: new Set() });
});

describe('pending and failure fall back to English', () => {
    it('a pending translation shimmers the English text, never the original, as one accessible text', async () => {
        render(card());
        await waitFor(() => expect(screen.getByTestId('translatable-pending')).toBeTruthy());
        expect(screen.getAllByText(EN)).toHaveLength(1);
        expect(screen.queryByText(HI)).toBeNull();
        expect(screen.getByTestId('translatable-pending').props.accessibilityState).toEqual({ busy: true });
        expect(screen.queryByTestId('translatable-failed')).toBeNull();
    });

    it('a failed card text shows English and a glyph hidden from accessibility, and says so to its card', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        const onDisplayChange = jest.fn();
        render(card({ onDisplayChange }));
        await waitFor(() =>
            expect(screen.getByTestId('translatable-failed', { includeHiddenElements: true })).toBeTruthy(),
        );
        expect(screen.getByText(EN)).toBeTruthy();
        expect(screen.queryByText(HI)).toBeNull();
        expect(screen.queryByTestId('translatable-failed')).toBeNull();
        const last = onDisplayChange.mock.calls.at(-1)?.[0] as TranslatableDisplayState;
        expect(last).toMatchObject({ displayedText: EN, displayedLanguage: 'en', translationFailed: true });
    });

    it('a failed detail text has a labelled glyph button whose tap shows the tooltip', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        render(detail());
        const glyph = await screen.findByTestId('translatable-failed');
        expect(glyph.props.accessibilityLabel).toBe(FAILED);
        expect(glyph.props.accessibilityRole).toBe('button');
        fireEvent.press(glyph);
        await waitFor(() => expect(screen.getByTestId('translatable-failed-tooltip')).toBeTruthy());
        expect(screen.getByText(FAILED)).toBeTruthy();
    });

    it('a blocked language shows English and the failed glyph without asking', async () => {
        mockBlocked = true;
        render(detail());
        expect(screen.getByTestId('translatable-failed')).toBeTruthy();
        expect(screen.getByText(EN, { exact: false })).toBeTruthy();
        await settle();
        expect(mockTranslate).not.toHaveBeenCalled();
    });

    it('a late cache write replaces a failure with the translation and no glyph', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        render(detail());
        await screen.findByTestId('translatable-failed');
        act(() => useAppLanguageStore.getState().cacheTranslation(EN, MR));
        await waitFor(() => expect(screen.getByText(MR)).toBeTruthy());
        expect(screen.queryByTestId('translatable-failed')).toBeNull();
    });
});

describe('the glyph only where it belongs', () => {
    it('a translated card text shows the translation and no glyph', async () => {
        mockNextOutcome = async () => ({ status: 'ok', text: MR });
        render(card({ showTranslatedGlyph: false }));
        await waitFor(() => expect(screen.getByText(MR)).toBeTruthy());
        expect(screen.queryByTestId('translatable-failed', { includeHiddenElements: true })).toBeNull();
        expect(screen.queryByTestId('translatable-translated', { includeHiddenElements: true })).toBeNull();
    });

    it('a translated detail text ends with the plain decorative glyph', async () => {
        mockNextOutcome = async () => ({ status: 'ok', text: MR });
        render(detail({ showTranslatedGlyph: true }));
        await waitFor(() => expect(screen.getByText(MR, { exact: false })).toBeTruthy());
        expect(screen.getByTestId('translatable-translated', { includeHiddenElements: true })).toBeTruthy();
        expect(screen.queryByTestId('translatable-translated')).toBeNull();
        expect(screen.queryByTestId('translatable-failed', { includeHiddenElements: true })).toBeNull();
    });

    it('a failed detail text with showTranslatedGlyph shows the slashed glyph, not the plain one', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        render(detail({ showTranslatedGlyph: true }));
        await screen.findByTestId('translatable-failed');
        expect(screen.queryByTestId('translatable-translated', { includeHiddenElements: true })).toBeNull();
    });

    it.each(['dropped', 'skipped'] as const)('a %s request shows no glyph', async (status) => {
        let first = true;
        mockNextOutcome = () => (first ? ((first = false), Promise.resolve({ status })) : new Promise(() => {}));
        render(detail());
        await waitFor(() => expect(mockTranslate).toHaveBeenCalled());
        await settle();
        expect(screen.queryByTestId('translatable-failed', { includeHiddenElements: true })).toBeNull();
        expect(screen.getByText(EN)).toBeTruthy();
    });

    it('an original already in the app language shows the original and asks nothing', async () => {
        useAppLanguageStore.setState({ appLanguage: 'hi' });
        render(detail());
        expect(screen.getByText(HI)).toBeTruthy();
        await settle();
        expect(mockTranslate).not.toHaveBeenCalled();
    });
});

describe('re-asking', () => {
    it('a failed text asks once more when the app comes back to the front, not while it stays there', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        render(detail());
        await screen.findByTestId('translatable-failed');
        await settle();
        expect(mockTranslate).toHaveBeenCalledTimes(1);
        act(() => {
            mockQueueActive = false;
            mockGateListeners.forEach((l) => l());
        });
        await settle();
        expect(mockTranslate).toHaveBeenCalledTimes(1);
        act(() => {
            mockQueueActive = true;
            mockGateListeners.forEach((l) => l());
        });
        await waitFor(() => expect(mockTranslate).toHaveBeenCalledTimes(2));
    });

    it('a failed text with the gate held open asks once; one rising edge asks exactly once more', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        render(detail());
        await screen.findByTestId('translatable-failed');
        await settle();
        expect(mockTranslate).toHaveBeenCalledTimes(1);

        setGate(false);
        await settle();
        expect(mockTranslate).toHaveBeenCalledTimes(1);
        setGate(true);
        await waitFor(() => expect(mockTranslate).toHaveBeenCalledTimes(2));
        await screen.findByTestId('translatable-failed');
        await settle();
        expect(mockTranslate).toHaveBeenCalledTimes(2);
    });

    it('a dropped text asks again once the gate opens', async () => {
        let first = true;
        mockNextOutcome = () => (first ? ((first = false), Promise.resolve({ status: 'dropped' as const })) : new Promise(() => {}));
        setGate(false);
        render(detail());
        await waitFor(() => expect(mockTranslate).toHaveBeenCalledTimes(1));
        await settle();
        expect(mockTranslate).toHaveBeenCalledTimes(1);
        setGate(true);
        await waitFor(() => expect(mockTranslate).toHaveBeenCalledTimes(2));
    });
});
