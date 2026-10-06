import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});

// The bar and results have their own suites; here they only record props.
const mockBarProps: any[] = [];
jest.mock('@/components/custom/explore/ExploreSearchBar', () => ({
    __esModule: true,
    default: (p: any) => {
        mockBarProps.push(p);
        return null;
    },
}));
const mockResultProps: any[] = [];
jest.mock('@/components/custom/explore/ExploreSearchResults', () => ({
    __esModule: true,
    default: (p: any) => {
        mockResultProps.push(p);
        return null;
    },
}));

const mockSearch = {
    query: '',
    setQuery: jest.fn(),
    clear: jest.fn(),
    status: 'idle',
    hits: [] as any[],
    errorKind: null,
    retry: jest.fn(),
    isActive: false,
};
jest.mock('@/lib/news-search/use-news-search', () => ({ useNewsSearch: () => mockSearch }));
const mockOpenArticle = jest.fn();
jest.mock('@/lib/hooks/use-open-article', () => ({ useOpenArticle: () => mockOpenArticle }));
let mockConnected = true;
jest.mock('@/lib/stores/network-store', () => ({ useIsConnected: () => mockConnected }));

const mockRouter = { canGoBack: jest.fn(() => true), back: jest.fn(), replace: jest.fn() };
jest.mock('expo-router', () => ({
    get router() {
        return mockRouter;
    },
}));

import SearchScreen from '../SearchScreen';

const last = <T,>(a: T[]): T => a[a.length - 1];

beforeEach(() => {
    jest.clearAllMocks();
    mockBarProps.length = 0;
    mockResultProps.length = 0;
    mockConnected = true;
    mockRouter.canGoBack.mockReturnValue(true);
});

describe('SearchScreen', () => {
    it('wires the bar to the search hook, with the World placeholder and no ✕', () => {
        render(<SearchScreen />);
        const bar = last(mockBarProps);
        expect(bar.placeholder).toBe('world.search.placeholder');
        expect(bar.onChangeQuery).toBe(mockSearch.setQuery);
        expect(bar.onClose).toBeUndefined();
    });

    it('Cancel is a labelled 44pt button that goes back', () => {
        const { StyleSheet } = require('react-native');
        const { getByTestId } = render(<SearchScreen />);
        const cancel = getByTestId('search-cancel');
        expect(cancel.props.accessibilityLabel).toBe('common.cancel');
        expect(cancel.props.accessibilityRole).toBe('button');
        expect(StyleSheet.flatten(cancel.props.style).minHeight).toBe(44);
        fireEvent.press(cancel);
        expect(mockRouter.back).toHaveBeenCalledTimes(1);
        expect(mockRouter.replace).not.toHaveBeenCalled();
    });

    it('Cancel with nothing underneath lands on the Feed tab', () => {
        mockRouter.canGoBack.mockReturnValue(false);
        const { getByTestId } = render(<SearchScreen />);
        fireEvent.press(getByTestId('search-cancel'));
        expect(mockRouter.back).not.toHaveBeenCalled();
        expect(mockRouter.replace).toHaveBeenCalledWith('/logged-in/app_container/feed');
    });

    it('passes the hook state and the offline flag to the results', () => {
        mockConnected = false;
        render(<SearchScreen />);
        const r = last(mockResultProps);
        expect(r.status).toBe('idle');
        expect(r.onRetry).toBe(mockSearch.retry);
        expect(r.offline).toBe(true);
    });

    it('a result tap opens that article', () => {
        render(<SearchScreen />);
        last(mockResultProps).onPressHit({ _id: 'a1' });
        expect(mockOpenArticle).toHaveBeenCalledWith({ articleId: 'a1' });
    });

    // Decision 8: search keeps no history. The query lives only in React
    // state; neither the screen nor the hook may import a persistence layer.
    it.each(['components/custom/world/SearchScreen.tsx', 'lib/news-search/use-news-search.ts'])(
        '%s imports no storage',
        (rel) => {
            const fs = require('fs');
            const path = require('path');
            const src: string = fs.readFileSync(path.join(__dirname, '../../../..', rel), 'utf8');
            expect(src).not.toMatch(/setting-service|async-storage|AsyncStorage|secure-store|mmkv|lib\/database|lib\/stores\/(?!network-store)/);
        },
    );
});
