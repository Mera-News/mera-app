// TabPages and the translation queue: a page change the READER makes (swipe or pill) drops the
// queued translations, like a route change; a page set in code (mount, restore, deep link, page
// request) drops nothing. usePageActive tells a node whether its page is the visible one. The pager,
// header and native/animation edges are faked; TabPages and the queue are real.
import { act, render } from '@testing-library/react-native';
import React from 'react';

import TabPages from '@/components/custom/nav/TabPages';
import { usePageActive } from '@/components/custom/nav/page-active';
import { resetPendingPage, setPendingPage } from '@/components/custom/nav/navigate-to-page';
import {
    __resetTranslationQueueForTests,
    enqueueTranslationTask,
    getTranslationEpoch,
    isDropped,
} from '@/lib/translation-queue';

jest.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
    useNavigation: () => ({ isFocused: () => true }),
    useRoute: () => ({ key: 'library-1' }),
}));
jest.mock('@/lib/hooks/use-collapsible-header', () => ({
    useCollapsibleHeader: () => ({
        scrollHandler: () => {},
        headerStyle: {},
        onHeaderLayout: () => {},
        headerHeight: 0,
        reveal: () => {},
        resetScrollOrigin: () => {},
        hidden: { value: false },
    }),
}));
jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: { View }, useAnimatedScrollHandler: () => () => {}, makeMutable: (v: unknown) => ({ value: v }) };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/haptics', () => ({ hapticSelection: jest.fn() }));
jest.mock('@/lib/motion-gate', () => ({ useMotionAllowed: () => false }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => () => null);
jest.mock('@/components/custom/nav/HeaderGlass', () => () => null);
jest.mock('@/components/custom/nav/PageStrip', () => ({
    __esModule: true,
    default: () => null,
    HEADER_BOTTOM_PAD: 0,
    HEADER_SIDE_PAD: 0,
    HEADER_TOP_PAD: 0,
}));
jest.mock('@/components/custom/nav/PageExplainerSheet', () => () => null);
jest.mock('@/components/custom/nav/ArrangeOverlay', () => () => null);
jest.mock('@/components/custom/nav/RestoreReveal', () => ({ children }: { children: React.ReactNode }) => children);
let mockSwipeTo: (i: number) => void = () => {};
jest.mock('@/components/custom/nav/PagePager', () => ({
    __esModule: true,
    default: ({ count, index, renderPanel, onIndexChange }: {
        count: number;
        index: number;
        renderPanel: (i: number, a: boolean) => React.ReactNode;
        onIndexChange: (i: number) => void;
    }) => {
        const { View } = require('react-native');
        mockSwipeTo = onIndexChange;
        return <View>{Array.from({ length: count }, (_, i) => <View key={i}>{renderPanel(i, i === index)}</View>)}</View>;
    },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const seen: Record<string, boolean> = {};
function Page({ id }: { id: string }) {
    seen[id] = usePageActive();
    return null;
}

const pages = [
    { id: 'saved', label: 'Saved' },
    { id: 'checks', label: 'Checks' },
] as never;

const renderTabs = () =>
    render(<TabPages tab="library" pages={pages} renderPage={({ pageId }) => <Page id={pageId} />} />);

beforeEach(() => {
    __resetTranslationQueueForTests();
    resetPendingPage();
});

describe('TabPages and the translation epoch', () => {
    it('drops nothing on mount', () => {
        const before = getTranslationEpoch();
        renderTabs();
        expect(getTranslationEpoch()).toBe(before);
    });

    it('drops the queued translations when the reader swipes to another page', async () => {
        renderTabs();
        // Occupy the slot so the next item stays queued.
        void enqueueTranslationTask(() => new Promise(() => {}));
        const queued = enqueueTranslationTask(async () => 'never');
        const before = getTranslationEpoch();

        act(() => mockSwipeTo(1));

        expect(getTranslationEpoch()).toBe(before + 1);
        expect(isDropped(await queued)).toBe(true);
    });

    it('drops nothing for a page set in code (a page request)', () => {
        renderTabs();
        const before = getTranslationEpoch();
        act(() => setPendingPage('checks' as never));
        expect(seen.checks).toBe(true);
        expect(getTranslationEpoch()).toBe(before);
    });
});

describe('usePageActive', () => {
    it('is true for the visible page only, and true outside TabPages', () => {
        renderTabs();
        expect(seen).toMatchObject({ saved: true, checks: false });
        act(() => mockSwipeTo(1));
        expect(seen).toMatchObject({ saved: false, checks: true });

        render(<Page id="loose" />);
        expect(seen.loose).toBe(true);
    });
});
