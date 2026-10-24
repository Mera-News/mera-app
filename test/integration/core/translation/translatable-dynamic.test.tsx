// TranslatableDynamic's on-screen states: English is the only fallback (pending and
// failed both show `text`, never the source language), a translating text shimmers, a
// failed one ends in a tappable slashed translate glyph whose tooltip says what to do,
// and the detail screen marks a machine translation with a plain glyph.
// The translation service is faked at its edge; the store, i18n and popover are real.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import TranslatableDynamic, { type TranslatableDisplayState } from '@/components/custom/TranslatableDynamic';
import { createPageActiveSource, PageActiveContext } from '@/components/custom/nav/page-active';
import { NavigationContext } from '@react-navigation/native';
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
// The service's per-(text, lang) failure state and interest counts, faked at its edge.
const mockFailed = new Set<string>();
const mockFailedListeners = new Set<() => void>();
const mockInterest = new Map<string, number>();
const mockKey = (text: string, lang: string) => `${lang}::${text}`;
const setTextFailed = (text: string, lang: string, failed: boolean) => {
    if (failed) mockFailed.add(mockKey(text, lang));
    else mockFailed.delete(mockKey(text, lang));
    mockFailedListeners.forEach((l) => l());
};
const mockTranslate = jest.fn(async (text: string, lang: string) => {
    const outcome = await mockNextOutcome();
    // The service records a failure; the node reads it back.
    if (outcome.status === 'failed') setTextFailed(text, lang, true);
    return outcome;
});
let mockBlock: { permanent: boolean } | null = null;
let mockGated = false;
jest.mock('@/lib/translation-service', () => {
    const { useSyncExternalStore } = require('react');
    return {
        ...jest.requireActual('@/lib/translation-service'),
        translateTextDetailed: (text: string, lang: string) => mockTranslate(text, lang),
        useTranslationSuppressed: () => mockBlock != null || mockGated,
        useTranslationBlocked: () => mockBlock,
        useTextTranslationFailed: (text: string, lang: string) =>
            useSyncExternalStore(
                (l: () => void) => {
                    mockFailedListeners.add(l);
                    return () => mockFailedListeners.delete(l);
                },
                () => mockFailed.has(mockKey(text, lang)),
            ),
        retainTranslationInterest: (text: string, lang: string) => {
            const key = mockKey(text, lang);
            mockInterest.set(key, (mockInterest.get(key) ?? 0) + 1);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                mockInterest.set(key, (mockInterest.get(key) ?? 1) - 1);
            };
        },
    };
});
const interestIn = (text: string, lang = 'mr') => mockInterest.get(mockKey(text, lang)) ?? 0;

// The app is in front (the queue is not paused).
let mockQueueActive = true;
// A function declaration, hoisted with the mock: the engine subscribes at import, before any const.
function mockQueueListenerSet(): Set<() => void> {
    const g = globalThis as { __mockQueueListeners?: Set<() => void> };
    return (g.__mockQueueListeners ??= new Set());
}
const mockQueueListeners = mockQueueListenerSet();
jest.mock('@/lib/translation-queue', () => ({
    ...jest.requireActual('@/lib/translation-queue'),
    isTranslationQueueActive: () => mockQueueActive,
    subscribeQueueActive: (l: () => void) => {
        mockQueueListenerSet().add(l);
        return () => mockQueueListenerSet().delete(l);
    },
}));
const setQueueActive = (active: boolean) =>
    act(() => {
        mockQueueActive = active;
        mockQueueListeners.forEach((l) => l());
    });

jest.mock('@/lib/hooks/use-is-focused-safe', () => ({
    ...jest.requireActual('@/lib/hooks/use-is-focused-safe'),
    useAnimationsActive: () => true,
}));

// The screen's focus, through the navigation object the component reads.
let focused = true;
const focusListeners = new Set<() => void>();
const navigation = {
    isFocused: () => focused,
    addListener: (_event: string, l: () => void) => {
        focusListeners.add(l);
        return () => focusListeners.delete(l);
    },
};
const setFocused = (next: boolean) =>
    act(() => {
        focused = next;
        focusListeners.forEach((l) => l());
    });

let page = createPageActiveSource(true);

const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <NavigationContext.Provider value={navigation as never}>
        <PageActiveContext.Provider value={page}>{children}</PageActiveContext.Provider>
    </NavigationContext.Provider>
);
const mount = (el: React.ReactElement) => render(el, { wrapper: Wrapper });

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
const findFailed = () => screen.findByTestId('translatable-failed', { includeHiddenElements: true });
const getFailed = () => screen.getByTestId('translatable-failed', { includeHiddenElements: true });
/** No private-use icon glyph and no U+FFFC (an inline View read by iOS) in a spoken label. */
const expectCleanLabel = (label: unknown) => {
    expect(typeof label).toBe('string');
    expect(label as string).not.toMatch(/[\uE000-\uF8FF\uFFFC]/);
};

beforeAll(initI18nEn);
beforeEach(() => {
    MockNativeMethods.measureInWindow.mockImplementation((cb: (...n: number[]) => void) => cb(0, 100, 300, 20));
    mockTranslate.mockClear();
    mockBlock = null;
    mockFailed.clear();
    mockInterest.clear();
    mockGated = false;
    focused = true;
    mockQueueActive = true;
    page = createPageActiveSource(true);
    mockNextOutcome = () => new Promise(() => {});
    useAppLanguageStore.setState({ appLanguage: 'mr', cache: new Map(), pending: new Set() });
});

describe('pending and failure fall back to English', () => {
    it('a pending translation shimmers the English text, never the original, as one accessible text', async () => {
        mount(card());
        await waitFor(() => expect(screen.getByTestId('translatable-pending')).toBeTruthy());
        expect(screen.getAllByText(EN)).toHaveLength(1);
        expect(screen.queryByText(HI)).toBeNull();
        expect(screen.queryByTestId('translatable-failed')).toBeNull();
    });

    it('a failed card text shows English and a glyph hidden from accessibility, and says so to its card', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        const onDisplayChange = jest.fn();
        mount(card({ failedGlyph: 'spokenByHost', onDisplayChange }));
        await waitFor(() =>
            expect(screen.getByTestId('translatable-failed', { includeHiddenElements: true })).toBeTruthy(),
        );
        expect(screen.getByText(EN)).toBeTruthy();
        expect(screen.queryByText(HI)).toBeNull();
        expect(screen.queryByTestId('translatable-failed')).toBeNull();
        const last = onDisplayChange.mock.calls.at(-1)?.[0] as TranslatableDisplayState;
        expect(last).toMatchObject({ displayedText: EN, displayedLanguage: 'en', translationFailed: true });
    });

    it('a failed detail text speaks the failure on its own Text, with the tooltip as an action', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        mount(detail());
        // The inline glyph is not its own element on iOS (the Text reads it as U+FFFC): it is hidden.
        const glyph = await findFailed();
        expect(glyph.props.accessibilityLabel).toBeUndefined();
        const textNode = screen.getByLabelText(`${EN}, ${FAILED}`);
        expectCleanLabel(textNode.props.accessibilityLabel);
        expect(textNode.props.accessibilityActions).toEqual([{ name: 'translationFailed', label: FAILED }]);
        fireEvent(textNode, 'accessibilityAction', { nativeEvent: { actionName: 'translationFailed' } });
        await waitFor(() => expect(screen.getByTestId('translatable-failed-tooltip')).toBeTruthy());
        expect(screen.getByText(FAILED)).toBeTruthy();
    });

    it('a sighted tap on the hidden inline glyph still opens the tooltip', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        mount(detail());
        fireEvent.press(await findFailed());
        await waitFor(() => expect(screen.getByTestId('translatable-failed-tooltip')).toBeTruthy());
    });

    it('a blocked language shows English and the failed glyph without asking', async () => {
        mockBlock = { permanent: false };
        mount(detail());
        expect(getFailed()).toBeTruthy();
        expect(screen.getByText(EN, { exact: false })).toBeTruthy();
        await settle();
        expect(mockTranslate).not.toHaveBeenCalled();
    });

    it('a late cache write replaces a failure with the translation and no glyph', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        mount(detail());
        await findFailed();
        act(() => useAppLanguageStore.getState().cacheTranslation(EN, MR));
        await waitFor(() => expect(screen.getByText(MR)).toBeTruthy());
        expect(screen.queryByTestId('translatable-failed')).toBeNull();
    });
});

describe('the glyph only where it belongs', () => {
    it('a translated card text shows the translation and no glyph', async () => {
        mockNextOutcome = async () => ({ status: 'ok', text: MR });
        mount(card({ showTranslatedGlyph: false }));
        await waitFor(() => expect(screen.getByText(MR)).toBeTruthy());
        expect(screen.queryByTestId('translatable-failed', { includeHiddenElements: true })).toBeNull();
        expect(screen.queryByTestId('translatable-translated', { includeHiddenElements: true })).toBeNull();
    });

    it('a translated detail text ends with the plain decorative glyph', async () => {
        mockNextOutcome = async () => ({ status: 'ok', text: MR });
        mount(detail({ showTranslatedGlyph: true }));
        await waitFor(() => expect(screen.getByText(MR, { exact: false })).toBeTruthy());
        expect(screen.getByTestId('translatable-translated', { includeHiddenElements: true })).toBeTruthy();
        expect(screen.queryByTestId('translatable-translated')).toBeNull();
        expect(screen.queryByTestId('translatable-failed', { includeHiddenElements: true })).toBeNull();
    });

    it('a failed detail text with showTranslatedGlyph shows the slashed glyph, not the plain one', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        mount(detail({ showTranslatedGlyph: true }));
        await findFailed();
        expect(screen.queryByTestId('translatable-translated', { includeHiddenElements: true })).toBeNull();
    });

    it.each(['dropped', 'skipped'] as const)('a %s request shows no glyph', async (status) => {
        let first = true;
        mockNextOutcome = () => (first ? ((first = false), Promise.resolve({ status })) : new Promise(() => {}));
        mount(detail());
        await waitFor(() => expect(mockTranslate).toHaveBeenCalled());
        await settle();
        expect(screen.queryByTestId('translatable-failed', { includeHiddenElements: true })).toBeNull();
        expect(screen.getByText(EN)).toBeTruthy();
    });

    it('an original already in the app language shows the original and asks nothing', async () => {
        useAppLanguageStore.setState({ appLanguage: 'hi' });
        mount(detail());
        expect(screen.getByText(HI)).toBeTruthy();
        await settle();
        expect(mockTranslate).not.toHaveBeenCalled();
    });
});

describe('re-asking', () => {
    it('a failed visible node holds retry interest, and lets go on blur, page change and background', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        const view = mount(detail());
        await findFailed();
        expect(interestIn(EN)).toBe(1);
        setFocused(false);
        expect(interestIn(EN)).toBe(0);
        setFocused(true);
        expect(interestIn(EN)).toBe(1);
        act(() => page.set(false));
        expect(interestIn(EN)).toBe(0);
        act(() => page.set(true));
        expect(interestIn(EN)).toBe(1);
        setQueueActive(false);
        expect(interestIn(EN)).toBe(0);
        setQueueActive(true);
        expect(interestIn(EN)).toBe(1);
        view.unmount();
        expect(interestIn(EN)).toBe(0);
    });

    it('a failed node never re-asks itself: the service retries, and no shimmer shows while one is owed', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        mount(detail());
        await findFailed();
        setFocused(false);
        setFocused(true);
        setQueueActive(false);
        setQueueActive(true);
        await settle();
        expect(mockTranslate).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('translatable-pending')).toBeNull();
        expect(getFailed()).toBeTruthy();
    });

    it('a retry landing in the cache clears the glyph and the interest', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        mount(detail());
        await findFailed();
        act(() => {
            useAppLanguageStore.getState().cacheTranslation(EN, MR);
            setTextFailed(EN, 'mr', false);
        });
        await waitFor(() => expect(screen.getByText(MR)).toBeTruthy());
        expect(screen.queryByTestId('translatable-failed', { includeHiddenElements: true })).toBeNull();
        expect(interestIn(EN)).toBe(0);
    });

    it('a translated node never holds interest', async () => {
        mockNextOutcome = async () => ({ status: 'ok', text: MR });
        mount(detail());
        await waitFor(() => expect(screen.getByText(MR)).toBeTruthy());
        expect(mockInterest.size).toBe(0);
    });

    it('a lifted breaker clears a glyph that was only the block', async () => {
        mockBlock = { permanent: false };
        const view = mount(detail());
        expect(getFailed()).toBeTruthy();
        mockBlock = null;
        mockNextOutcome = async () => ({ status: 'ok', text: MR });
        view.rerender(detail());
        await waitFor(() => expect(screen.getByText(MR)).toBeTruthy());
        expect(screen.queryByTestId('translatable-failed', { includeHiddenElements: true })).toBeNull();
    });

    it('a dropped text on a warm neighbour page waits until its page is the visible one', async () => {
        let first = true;
        mockNextOutcome = () => (first ? ((first = false), Promise.resolve({ status: 'dropped' as const })) : new Promise(() => {}));
        page = createPageActiveSource(false);
        mount(detail());
        await waitFor(() => expect(mockTranslate).toHaveBeenCalledTimes(1));
        await settle();
        expect(mockTranslate).toHaveBeenCalledTimes(1);
        act(() => page.set(true));
        await waitFor(() => expect(mockTranslate).toHaveBeenCalledTimes(2));
    });

    it('a dropped text asks again once the gate opens', async () => {
        let first = true;
        mockNextOutcome = () => (first ? ((first = false), Promise.resolve({ status: 'dropped' as const })) : new Promise(() => {}));
        setFocused(false);
        mount(detail());
        await waitFor(() => expect(mockTranslate).toHaveBeenCalledTimes(1));
        await settle();
        expect(mockTranslate).toHaveBeenCalledTimes(1);
        setFocused(true);
        await waitFor(() => expect(mockTranslate).toHaveBeenCalledTimes(2));
    });
});

describe('nothing owed, nothing heard', () => {
    it('a translated node does not re-render when focus, page or app state changes', async () => {
        mockNextOutcome = async () => ({ status: 'ok', text: MR });
        let renders = 0;
        mount(
            <React.Profiler id="t" onRender={() => (renders += 1)}>
                {detail()}
            </React.Profiler>,
        );
        await waitFor(() => expect(screen.getByText(MR)).toBeTruthy());
        await settle();
        const before = renders;
        setFocused(false);
        setFocused(true);
        act(() => page.set(false));
        act(() => page.set(true));
        setQueueActive(false);
        setQueueActive(true);
        await settle();
        expect(renders).toBe(before);
    });

    it('a new app language clears the old failure', async () => {
        mockNextOutcome = async () => ({ status: 'failed' });
        mount(detail());
        await findFailed();
        // The new language is not verified yet: nothing is asked, so only the reset can clear it.
        mockGated = true;
        act(() => useAppLanguageStore.setState({ appLanguage: 'ta' }));
        await settle();
        expect(screen.queryByTestId('translatable-failed', { includeHiddenElements: true })).toBeNull();
    });
});

describe('who speaks the failure', () => {
    it('a permanent block (no translator for the language) draws no glyph', async () => {
        mockBlock = { permanent: true };
        mount(detail());
        await settle();
        expect(screen.getByText(EN)).toBeTruthy();
        expect(screen.queryByTestId('translatable-failed', { includeHiddenElements: true })).toBeNull();
    });

    it('spokenByHost: hidden from accessibility, still opens the tooltip', async () => {
        mockBlock = { permanent: false };
        mount(card({ failedGlyph: 'spokenByHost' }));
        const glyph = screen.getByTestId('translatable-failed', { includeHiddenElements: true });
        expect(glyph.props.accessibilityLabel).toBeUndefined();
        fireEvent.press(glyph);
        await waitFor(() => expect(screen.getByTestId('translatable-failed-tooltip')).toBeTruthy());
    });

    it('decorative: drawn, hidden, and a tap opens nothing', async () => {
        mockBlock = { permanent: false };
        mount(card({ failedGlyph: 'decorative' }));
        const glyph = screen.getByTestId('translatable-failed', { includeHiddenElements: true });
        fireEvent.press(glyph);
        await settle();
        expect(screen.queryByTestId('translatable-failed-tooltip', { includeHiddenElements: true })).toBeNull();
    });

    it('a clamped button is a childless labelled Pressable: the glyph is not inside it', async () => {
        mockBlock = { permanent: false };
        mount(card({ failedGlyph: 'button' }));
        const glyph = screen.getByTestId('translatable-failed');
        expect(glyph.props.accessibilityLabel).toBe(FAILED);
        expect(glyph.props.accessibilityRole).toBe('button');
        expect(glyph.findAll((n: { props?: { name?: string } }) => n.props?.name === 'translate-off')).toHaveLength(0);
        expect(screen.UNSAFE_getAllByProps({ name: 'translate-off' }).length).toBeGreaterThan(0);
    });
});

describe('the clamped glyph row', () => {
    it('sizes the glyph from the caller font size and line height, and keeps LTR for English', async () => {
        mockBlock = { permanent: false };
        mount(card({ failedGlyph: 'decorative', style: { fontSize: 16, lineHeight: 21 } }));
        const glyph = screen.getByTestId('translatable-failed', { includeHiddenElements: true });
        expect(glyph.props.style).toMatchObject({ width: 16, height: 21 });
        const row = screen.getByTestId('translatable-row', { includeHiddenElements: true });
        const rowStyle = Object.assign({}, ...[row.props.style].flat(3).filter(Boolean));
        expect(rowStyle).toMatchObject({ flexDirection: 'row', direction: 'ltr' });
    });

    it('clamps the touch frame to the reach the host allows', async () => {
        mockBlock = { permanent: false };
        mount(card({ failedGlyph: 'spokenByHost', glyphReach: { above: 0, below: 0, end: 14 }, style: { fontSize: 16, lineHeight: 24 } }));
        const frame = screen.getByTestId('translatable-failed', { includeHiddenElements: true });
        expect(frame.props.style).toMatchObject({ top: -0, bottom: -0, right: -14, left: -5 });
    });
});

describe('detail labels carry no icon characters', () => {
    it('a translated detail text with the plain glyph is labelled by its text alone', async () => {
        mockNextOutcome = async () => ({ status: 'ok', text: MR });
        mount(detail({ showTranslatedGlyph: true }));
        const node = await screen.findByLabelText(MR);
        expectCleanLabel(node.props.accessibilityLabel);
        expect(node.props.accessibilityActions).toBeUndefined();
    });

    it('the Show original toggle is labelled by its text, not its icon', async () => {
        render(detail({ showToggle: true }), { wrapper: Wrapper });
        const toggle = screen.getByRole('button', { name: 'Show original' });
        expectCleanLabel(toggle.props.accessibilityLabel);
        expect(toggle.props.accessibilityLabel).toBe('Show original');
    });
});
