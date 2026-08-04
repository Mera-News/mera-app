// TranslatableDynamic (r6b) — verifies the `onDisplayChange` callback fires
// (in an effect) with the effective displayed text AND the language that text
// is in, so a parent can mirror the exact title variant the reader sees. Covers
// the no-translation paths:
//   • appLanguage 'en' → the English `text` is shown (showingOriginal false);
//   • original already in the app language → the original is shown
//     (showingOriginal true);
//   • translation unavailable/pending → the ORIGINAL is shown while
//     showingOriginal is still false, which is exactly why `displayedLanguage`
//     exists and the boolean isn't enough (see lib/hooks/useShareArticle.ts).
/* eslint-disable @typescript-eslint/no-require-imports */

let mockAppLanguage = 'en';

// Controllable stand-in for the host node's `measureInWindow`. Plain `let`s, not
// jest mocks: `jest.clearAllMocks()` in beforeEach would silently reset a
// mock-based counter and make the retry-ladder test lie.
let mockMeasureCalls = 0;
/** Default = the RN test-renderer behaviour: the callback never fires. */
let mockMeasureImpl: (call: number, cb: (x: number, y: number, w: number, h: number) => void) => void =
    () => {};

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/lib/stores/app-language-store', () => {
    const makeState = () => ({
        appLanguage: mockAppLanguage,
        cache: new Map<string, string>(),
        pending: new Set<string>(),
        addPending: jest.fn(),
        removePending: jest.fn(),
        cacheTranslation: jest.fn(),
    });
    const useAppLanguageStore = (selector?: (s: any) => unknown) =>
        selector ? selector(makeState()) : makeState();
    (useAppLanguageStore as any).getState = () => makeState();
    return { useAppLanguageStore };
});

jest.mock('@/lib/translation-service', () => ({
    translateText: jest.fn(() => Promise.resolve(null)),
    // Not blocked by default — the breaker's own behaviour is covered in
    // lib/__tests__/translation-service.test.ts.
    useTranslationBlocked: jest.fn(() => null),
    // Not suppressed by default — the gate and the breaker are both covered
    // in lib/__tests__/translation-service.test.ts.
    useTranslationSuppressed: jest.fn(() => false),
}));

jest.mock('@/lib/visibility-tick', () => ({
    subscribeScrollTick: jest.fn(() => () => {}),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), warn: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

jest.mock('@/components/ui/heading', () => {
    const { Text } = require('react-native');
    return { Heading: (p: any) => <Text {...p} /> };
});
// The component measures through the ref it puts on this node, so the mock
// exposes a controllable `measureInWindow` via an imperative handle.
jest.mock('@/components/ui/text', () => {
    const ReactLib = require('react');
    const { Text } = require('react-native');
    const MockText = ReactLib.forwardRef((props: any, ref: any) => {
        ReactLib.useImperativeHandle(
            ref,
            () => ({
                measureInWindow: (cb: any) => {
                    mockMeasureCalls += 1;
                    mockMeasureImpl(mockMeasureCalls, cb);
                },
            }),
            [],
        );
        return <Text {...props} />;
    });
    return { Text: MockText };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});

import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { translateText } from '@/lib/translation-service';
import TranslatableDynamic from '../TranslatableDynamic';

describe('TranslatableDynamic onDisplayChange', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAppLanguage = 'en';
        mockMeasureCalls = 0;
        mockMeasureImpl = () => {};
    });

    it('fires with the English text when appLanguage is en (showingOriginal false)', async () => {
        const onDisplayChange = jest.fn();
        render(
            <TranslatableDynamic
                text="Breaking news headline"
                originalText="Manchete de última hora"
                originalLanguage="pt"
                onDisplayChange={onDisplayChange}
            />,
        );
        await waitFor(() => expect(onDisplayChange).toHaveBeenCalled());
        expect(onDisplayChange).toHaveBeenLastCalledWith({
            showingOriginal: false,
            displayedText: 'Breaking news headline',
            displayedLanguage: 'en',
        });
    });

    it('fires with the original text when it already matches the app language (showingOriginal true)', async () => {
        mockAppLanguage = 'pt';
        const onDisplayChange = jest.fn();
        render(
            <TranslatableDynamic
                text="Breaking news headline"
                originalText="Manchete de última hora"
                originalLanguage="pt"
                onDisplayChange={onDisplayChange}
            />,
        );
        await waitFor(() => expect(onDisplayChange).toHaveBeenCalled());
        expect(onDisplayChange).toHaveBeenLastCalledWith({
            showingOriginal: true,
            displayedText: 'Manchete de última hora',
            displayedLanguage: 'pt',
        });
    });

    it('reports the original language while the translation is unavailable, though showingOriginal is false', async () => {
        // translateText is mocked to resolve null, so this is the permanent
        // "OS can't translate this" state as well as the pending window.
        mockAppLanguage = 'de';
        const onDisplayChange = jest.fn();
        render(
            <TranslatableDynamic
                text="Breaking news headline"
                originalText="Manchete de última hora"
                originalLanguage="pt-BR"
                onDisplayChange={onDisplayChange}
            />,
        );
        await waitFor(() => expect(onDisplayChange).toHaveBeenCalled());
        expect(onDisplayChange).toHaveBeenLastCalledWith({
            showingOriginal: false,
            displayedText: 'Manchete de última hora',
            // canonicalized: `pt-BR` → `pt`
            displayedLanguage: 'pt',
        });
    });

    it('reports English when there is no original to fall back to', async () => {
        mockAppLanguage = 'de';
        const onDisplayChange = jest.fn();
        render(
            <TranslatableDynamic
                text="Breaking news headline"
                onDisplayChange={onDisplayChange}
            />,
        );
        await waitFor(() => expect(onDisplayChange).toHaveBeenCalled());
        expect(onDisplayChange).toHaveBeenLastCalledWith({
            showingOriginal: false,
            displayedText: 'Breaking news headline',
            displayedLanguage: 'en',
        });
    });
});

// The mount-time visibility check. Under Fabric a freshly-mounted FlatList cell
// can hand back a `measureInWindow` that returns WITHOUT invoking its callback,
// and the old single-shot `setTimeout(check, 0)` had no second chance: the node
// stayed "not on screen", the title rendered in its original language, and the
// user's first scroll tick was what finally resolved it — swapping the text and
// re-wrapping the card mid-scroll. The ladder re-asks at 0/150/450ms.
describe('TranslatableDynamic mount-time visibility ladder', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        mockAppLanguage = 'de';
        mockMeasureCalls = 0;
        mockMeasureImpl = () => {};
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('requests the translation without any scroll tick when the first measure callback never fires', () => {
        mockMeasureImpl = (call, cb) => {
            // 1st attempt: silently dropped. 2nd onwards: on-screen geometry.
            if (call >= 2) cb(0, 100, 320, 40);
        };

        render(<TranslatableDynamic text="Breaking news headline" />);
        // Only the component's own retries run — no `notifyScrollTick` is ever
        // delivered (subscribeScrollTick is mocked and its listener never called).
        act(() => {
            jest.advanceTimersByTime(500);
        });

        expect(mockMeasureCalls).toBeGreaterThanOrEqual(2);
        expect(translateText).toHaveBeenCalledWith('Breaking news headline', 'de');
    });

    it('does not treat a callback that never fires as visible', () => {
        // Guard against "just assume visible on timeout" — that would translate
        // (and pay the OS translator cost for) every off-screen node in the list.
        render(<TranslatableDynamic text="Another headline" />);
        act(() => {
            jest.advanceTimersByTime(500);
        });

        expect(mockMeasureCalls).toBeGreaterThanOrEqual(2);
        expect(translateText).not.toHaveBeenCalled();
    });
});
