/* eslint-disable @typescript-eslint/no-require-imports */
// app/tutorials/ — routing only, and TOP-LEVEL on purpose.
//
// The tutorials used to live at `app/logged-in/tutorials/`. The owner's rule is
// that an unauthed reader must be able to learn everything about Mera, so the
// flow may not sit behind the session gate — and the paywall now links straight
// into it, which is precisely a place a reader may have no plan and no session.
//
// So the assertion that matters here is the SIGNED-OUT one: both screens render
// real content with no session, no local user id, and no server tier. The
// screens themselves are real in this suite (only the leaves that reach native
// are stubbed) — stubbing them would make the test vacuous.
//
// The second assertion is Ask Mera. Signed out, `deriveAiAccess` answers
// `'unknown'` rather than `'locked'` (no server tier, an anonymous
// CustomerInfo), so the aiAccess guard alone would let the button through — and
// outside `/logged-in` there is no `FloatingChatHost` to render the popover it
// opens. `AskMeraButton` therefore self-gates on the local identity, and that is
// what the last two cases pin.
import { render } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/ErrorBoundary', () => ({ __esModule: true, default: ({ children }: any) => children }));
jest.mock('@/components/custom/ErrorFallback', () => ({ FullScreenErrorFallback: () => null }));
jest.mock('@/components/ui/gluestack-ui-provider', () => ({ GluestackUIProvider: ({ children }: any) => children }));

jest.mock('react-native-safe-area-context', () => {
    const { View } = require('react-native');
    return {
        SafeAreaView: (p: any) => <View {...p} />,
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    };
});

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('expo-router', () => ({
    router: { push: jest.fn(), back: jest.fn() },
    useLocalSearchParams: () => ({ chapter: 'welcome' }),
}));

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string) => {
            const en = require('@/lib/locales/en.json');
            const v = key.split('.').reduce<any>((acc, part) => acc?.[part], en);
            return typeof v === 'string' ? v : key;
        },
    }),
}));

jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

jest.mock('@/components/ui/scroll-view', () => {
    const { View } = require('react-native');
    return { ScrollView: (p: any) => <View {...p} /> };
});

jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));

jest.mock('@/components/custom/tutorials/SceneView', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="scene" /> };
});

// Completion state is the settings KV, which instantiates the WatermelonDB
// adapter at import. Nothing about it is session-scoped — which is half of why
// this flow can live outside `/logged-in` at all.
jest.mock('@/lib/stores/tutorials-store', () => ({
    useTutorialsStore: Object.assign(
        (selector: any) => selector({ completed: new Set<string>(), hydrated: true, markCompleted: jest.fn() }),
        { getState: () => ({ hydrate: jest.fn(), markMenuSeen: jest.fn(), markCompleted: jest.fn() }) },
    ),
}));

// Signed out by default: no local identity at all.
const mockLocalUserIdRef = { current: null as string | null };
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: (selector?: (s: unknown) => unknown) => {
        const state = { userId: mockLocalUserIdRef.current };
        return selector ? selector(state) : state;
    },
}));

// The real signed-out verdict: server silent, RevenueCat anonymous ⇒ 'unknown'.
jest.mock('@/lib/stores/subscription-store', () => ({ useAiAccess: () => 'unknown' }));
jest.mock('@/lib/stores/floating-chat-store', () => ({
    useFloatingChatStore: { getState: () => ({ openArticleFeedback: jest.fn(), setBubbleCenter: jest.fn() }) },
}));

import TutorialsMenuRoute from '../tutorials/index';
import TutorialPlayerRoute from '../tutorials/player';

beforeEach(() => {
    mockLocalUserIdRef.current = null;
});

describe('app/tutorials (no session)', () => {
    it('renders the chapter menu signed out', () => {
        const { getByTestId } = render(<TutorialsMenuRoute />);

        expect(getByTestId('tutorials-screen')).toBeTruthy();
        // Real rows from the real registry, not an empty shell.
        expect(getByTestId('tutorial-row-welcome')).toBeTruthy();
    });

    it('renders the player signed out', () => {
        const { getByTestId } = render(<TutorialPlayerRoute />);

        // First card of the pre-auth chapter, with its tap zones.
        expect(getByTestId('tutorial-slide-what')).toBeTruthy();
        expect(getByTestId('tutorial-tap-next', { includeHiddenElements: true })).toBeTruthy();
        expect(getByTestId('tutorial-tap-prev', { includeHiddenElements: true })).toBeTruthy();
    });

    // `facts` is a post-auth chapter and every one of its cards carries
    // `hasAsk`. Signed out the affordance must simply not be there — the press
    // would open a chat store nothing is mounted to render.
    it('hides Ask Mera on a post-auth chapter when there is no local identity', () => {
        const TutorialPlayer = require('@/components/custom/tutorials/TutorialPlayer').default;
        const { queryByTestId } = render(
            <TutorialPlayer chapterId="facts" onClose={jest.fn()} />,
        );

        expect(queryByTestId('tutorial-slide-a-fact-is')).not.toBeNull();
        expect(queryByTestId('tutorial-ask-mera')).toBeNull();
    });

    it('shows Ask Mera on the same chapter once there is one', () => {
        mockLocalUserIdRef.current = 'local-u1';
        const TutorialPlayer = require('@/components/custom/tutorials/TutorialPlayer').default;
        const { queryByTestId } = render(
            <TutorialPlayer chapterId="facts" onClose={jest.fn()} />,
        );

        expect(queryByTestId('tutorial-ask-mera')).not.toBeNull();
    });
});
