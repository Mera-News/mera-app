// Dashboard collapsing header — the four legs, per sub-tab panel.
//
// The header hid on Overview but stayed pinned on Stories / Saved / History.
// Root cause was NOT a missing handler alone: each of those three panels owned a
// plain RN `FlatList`, and a `useAnimatedScrollHandler` worklet attached to a
// non-Animated component never reaches the UI thread. They also took the header's
// height as `paddingTop` on a WRAPPER View in ForYouScreen, which reserves the
// space statically — so there was nothing to scroll under, and hiding the header
// would only have left a dead gap.
//
// These tests pin all four legs that have to be present together, because a
// missing one fails silently on device and is invisible in a render test that
// only checks the handler:
//   1. `onScroll`   — the host's handler, on an Animated list
//   2. `scrollEventThrottle`
//   3. `contentContainerStyle.paddingTop === headerHeight`
//   4. `progressViewOffset === headerHeight` wherever a RefreshControl exists
//
// They also pin the STANDALONE default (`headerHeight` omitted ⇒ 0), since all
// three panels are also reachable as their own routes and that is the regression
// that would silently break three screens at once.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

// Animated.FlatList → a View that SPREADS its remaining props (so the assertions
// below can read the exact props each panel handed the list) AND renders
// `ListHeaderComponent`. The header matters here: each panel's own title moved
// from a sibling above the list INTO the list, which is what lets it scroll away
// under the collapsing header instead of sitting pinned behind it.
jest.mock('react-native-reanimated', () => {
    const ReactLib = require('react');
    const { View } = jest.requireActual('react-native');
    const resolve = (C: any) =>
        ReactLib.isValidElement(C) ? C : typeof C === 'function' ? ReactLib.createElement(C) : null;
    return {
        __esModule: true,
        default: {
            FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ...rest }: any) =>
                ReactLib.createElement(View, rest, resolve(ListHeaderComponent)),
            View,
        },
        useAnimatedScrollHandler: () => ({}),
        useSharedValue: (v: any) => ({ value: v }),
        useAnimatedStyle: () => ({}),
        runOnJS: (fn: any) => fn,
    };
});

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-router', () => ({
    router: { push: jest.fn() },
    useFocusEffect: (cb: any) => require('react').useEffect(cb, [cb]),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/SourceFlag', () => ({ SourceFlag: () => null }));
// Pulls the native ExpoTranslateText module, absent under Jest. Row content is
// irrelevant here — these assertions only read the list's own props.
jest.mock('@/components/custom/TranslatableDynamic', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/AiDisclosureCaption', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/toast', () => ({
    useToast: () => ({ show: jest.fn() }),
    Toast: () => null,
    ToastTitle: () => null,
    ToastDescription: () => null,
}));
jest.mock('@/components/custom/cards/ArticleSuggestionCard', () => ({ ArticleSuggestionCard: () => null }));
jest.mock('@/components/custom/cards/ArticleStandaloneCard', () => ({ ArticleStandaloneCard: () => null }));
// Both pull RN's ActivityIndicator, which jest-expo mis-transforms
// ("Unexpected token 'export'" out of ActivityIndicatorViewNativeComponent).
// Neither renders anything these assertions read.
jest.mock('@/components/ui/button', () => ({ Button: () => null, ButtonText: () => null }));
jest.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
// Gluestack's Modal pulls @legendapp/motion, which ships untransformed ESM.
// The confirm dialogs are covered by each panel's own suite; nothing here reads
// them.
jest.mock('@/components/ui/modal', () => ({
    Modal: () => null,
    ModalBackdrop: () => null,
    ModalBody: () => null,
    ModalContent: () => null,
    ModalFooter: () => null,
    ModalHeader: () => null,
}));

// ── Panel data sources ────────────────────────────────────────────────────
// lib/database/index.ts builds a real native SQLiteAdapter at import time, so
// every consumer suite mocks it (see the collectCoverageFrom note in
// jest.config.js). TrackedStoriesScreen reaches it transitively —
// FreeTierInlineNotice → present-free-tier-paywall → billing-service →
// apollo-client → for-you-store.
jest.mock('@/lib/database', () => ({
    __esModule: true,
    default: {
        write: jest.fn((fn: () => Promise<void>) => fn()),
        get: jest.fn(() => ({ query: jest.fn(() => ({ fetch: jest.fn(async () => []) })) })),
    },
}));
jest.mock('@/lib/database/services/tracked-story-service', () => ({
    MAX_MEMBER_IDS: 30,
    observeActive: () => ({
        subscribe: (o: any) => {
            o.next([]);
            return { unsubscribe: jest.fn() };
        },
    }),
}));
jest.mock('@/lib/tracking/track-actions', () => ({ deleteTrackedStoryById: jest.fn() }));
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
    loadSavedItems: () => Promise.resolve([]),
    deleteSavedSuggestion: jest.fn(),
}));
// One row, so History renders its LIST branch rather than the empty branch.
jest.mock('@/lib/database/services/publication-visit-service', () => ({
    getTopVisitedPublications: () =>
        Promise.resolve([{ publicationName: 'Le Monde', countryCode: 'FR', visitCount: 3, lastVisitedAt: Date.now() }]),
}));

import { render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import TrackedStoriesScreen from '@/components/custom/tracked-stories/TrackedStoriesScreen';
import VisitedPublicationsList from '@/components/custom/config-panel/VisitedPublicationsList';

const HEADER_H = 118;
/** Stand-in for the worklet object `useCollapsibleHeader` hands down. Identity is
 *  what matters — the panel must forward it untouched. */
const handler = { __collapsibleHeaderHandler: true } as any;

const flat = (s: any) => (Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : s ?? {});

describe('Stories panel', () => {
    const list = () => screen.getByTestId('tracked-stories-list');

    it('receives all the legs the collapsing header needs', () => {
        render(<TrackedStoriesScreen embedded scrollHandler={handler} headerHeight={HEADER_H} />);
        expect(list().props.onScroll).toBe(handler);
        expect(list().props.scrollEventThrottle).toBe(16);
        expect(flat(list().props.contentContainerStyle).paddingTop).toBe(HEADER_H);
    });

    // Retained deliberately: this is what lets ListEmptyComponent's `flex-1`
    // fill and centre. Easy to drop while editing the padding beside it.
    it('keeps flexGrow on the content container', () => {
        render(<TrackedStoriesScreen embedded scrollHandler={handler} headerHeight={HEADER_H} />);
        expect(flat(list().props.contentContainerStyle).flexGrow).toBe(1);
    });

    it('standalone (no headerHeight) pads by 0 and wires no handler', () => {
        render(<TrackedStoriesScreen onBack={jest.fn()} />);
        expect(flat(list().props.contentContainerStyle).paddingTop).toBe(0);
        expect(list().props.onScroll).toBeUndefined();
    });

    it('renders its title INSIDE the list so it scrolls with the content', () => {
        render(<TrackedStoriesScreen embedded scrollHandler={handler} headerHeight={HEADER_H} />);
        expect(screen.getByText('trackedStories.title')).toBeTruthy();
    });
});

describe('Saved panel', () => {
    const list = () => screen.getByTestId('saved-suggestions-list');

    it('receives all the legs the collapsing header needs', () => {
        render(<SavedSuggestionsScreen embedded onBack={jest.fn()} scrollHandler={handler} headerHeight={HEADER_H} />);
        expect(list().props.onScroll).toBe(handler);
        expect(list().props.scrollEventThrottle).toBe(16);
        expect(flat(list().props.contentContainerStyle).paddingTop).toBe(HEADER_H);
    });

    it('standalone (no headerHeight) pads by 0 and wires no handler', () => {
        render(<SavedSuggestionsScreen onBack={jest.fn()} />);
        expect(flat(list().props.contentContainerStyle).paddingTop).toBe(0);
        expect(list().props.onScroll).toBeUndefined();
    });

    // The title used to be a SIBLING above the list. Left there it would sit
    // pinned behind the absolute collapsing header — jammed under the status bar
    // once the header hid, and eating the space the collapse reclaims. It now
    // lives in ListHeaderComponent so it scrolls away with the rows. This panel
    // had no test suite of its own, so without this the relocation is uncovered.
    it('renders its title INSIDE the list so it scrolls with the content', () => {
        render(<SavedSuggestionsScreen embedded onBack={jest.fn()} scrollHandler={handler} headerHeight={HEADER_H} />);
        expect(screen.getByText('savedSuggestions.title')).toBeTruthy();
    });
});

describe('History panel', () => {
    const list = () => screen.getByTestId('visited-publications-list');

    it('receives all the legs the collapsing header needs', async () => {
        render(<VisitedPublicationsList embedded onBack={jest.fn()} scrollHandler={handler} headerHeight={HEADER_H} />);
        await waitFor(() => expect(screen.getByTestId('visited-publications-list')).toBeTruthy());
        expect(list().props.onScroll).toBe(handler);
        expect(list().props.scrollEventThrottle).toBe(16);
        expect(flat(list().props.contentContainerStyle).paddingTop).toBe(HEADER_H);
    });

    // The only one of the three with a RefreshControl. Without the offset the
    // refresh spinner drops from behind the collapsing header.
    it('offsets the refresh spinner by the header height', async () => {
        render(<VisitedPublicationsList embedded onBack={jest.fn()} scrollHandler={handler} headerHeight={HEADER_H} />);
        await waitFor(() => expect(screen.getByTestId('visited-publications-list')).toBeTruthy());
        expect(list().props.refreshControl.props.progressViewOffset).toBe(HEADER_H);
    });

    it('standalone (no headerHeight) pads by 0, offsets by 0, and wires no handler', async () => {
        render(<VisitedPublicationsList onBack={jest.fn()} />);
        await waitFor(() => expect(screen.getByTestId('visited-publications-list')).toBeTruthy());
        expect(flat(list().props.contentContainerStyle).paddingTop).toBe(0);
        expect(list().props.refreshControl.props.progressViewOffset).toBe(0);
        expect(list().props.onScroll).toBeUndefined();
    });
});
