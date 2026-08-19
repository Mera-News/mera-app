/* eslint-disable @typescript-eslint/no-require-imports */
// LegalFooter — the pre-auth "About Mera & legal" entry + sheet. Verifies the
// footer collapses to one tappable line + one meta line, and that every sheet
// row opens the right URL (policy pages localised via withAppLanguage, the
// project links raw — the same split the old pill/icon footer used).

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
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable: (p: any) => <Pressable {...p} /> };
});
jest.mock('@/components/ui/scroll-view', () => {
    // A plain View, not RN's ScrollView — importing the real one drags
    // untransformed react-native internals into the suite.
    const { View } = require('react-native');
    return { ScrollView: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/gluestack-ui-provider', () => ({
    GluestackUIProvider: (p: any) => p.children,
}));
// RN's Modal pulls an untransformed ESM native-component spec into jest; the
// sheet's behaviour has nothing to do with the host view, so render children
// straight through (same recipe as FeedbackTreeOverlay's suites).
jest.mock('react-native/Libraries/Modal/Modal', () => ({
    __esModule: true,
    default: (props: any) => (props.visible === false ? null : props.children),
}));
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/lib/version', () => ({ getAppVersionLabel: () => 'v1.3.0 (73)' }));

const mockOpen = jest.fn();
jest.mock('@/lib/web-browser-utils', () => ({
    openInAppBrowser: (...a: any[]) => mockOpen(...a),
    withAppLanguage: (u: string) => `${u}?lang=xx`,
}));
jest.mock('@/lib/config/branding', () => ({
    PRIVACY_URL: 'https://mera.news/privacy',
    TERMS_URL: 'https://mera.news/terms',
    CONTENT_POLICY_URL: 'https://mera.news/content-policy',
    FAQ_URL: 'https://mera.news/faq',
    GITHUB_URL: 'https://github.com/Mera-News',
    WEBSITE_URL: 'https://mera.news',
}));

import LegalFooter from '../LegalFooter';

beforeEach(() => jest.clearAllMocks());

describe('LegalFooter', () => {
    it('renders the entry line and the single meta line (copyright + version together)', () => {
        const { getByTestId, getByText } = render(<LegalFooter />);
        const entry = getByTestId('auth-about-legal');
        expect(entry.props.accessibilityRole).toBe('button');
        expect(entry.props.accessibilityLabel).toBe('auth.aboutLegal');
        expect(getByText(new RegExp('© \\d{4} Mera Labs B\\.V\\. · v1\\.3\\.0 \\(73\\)'))).toBeTruthy();
    });

    it('opens the sheet with all six rows, policy links localised and project links raw', () => {
        const { getByTestId } = render(<LegalFooter />);
        fireEvent.press(getByTestId('auth-about-legal'));

        const expectations: [string, string][] = [
            ['auth-legal-link-privacy', 'https://mera.news/privacy?lang=xx'],
            ['auth-legal-link-terms', 'https://mera.news/terms?lang=xx'],
            ['auth-legal-link-content', 'https://mera.news/content-policy?lang=xx'],
            ['auth-legal-link-faq', 'https://mera.news/faq?lang=xx'],
            ['auth-legal-link-source', 'https://github.com/Mera-News'],
            ['auth-legal-link-website', 'https://mera.news'],
        ];
        for (const [testID, url] of expectations) {
            fireEvent.press(getByTestId(testID));
            expect(mockOpen).toHaveBeenLastCalledWith(url);
        }
        expect(mockOpen).toHaveBeenCalledTimes(6);
    });
});
