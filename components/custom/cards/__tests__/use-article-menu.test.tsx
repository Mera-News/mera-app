/* eslint-disable @typescript-eslint/no-require-imports */
// The shared ••• menu (D3): which items appear where, that items run AFTER the
// sheet closes, that a failure offers a retry, and that Report a bug carries no
// article context.
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'Modal') {
                return ({ visible, children }: any) =>
                    visible === false ? null : ReactLib.createElement(ReactLib.Fragment, null, children);
            }
            return (target as any)[prop];
        },
    });
});
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string, o?: Record<string, string>) => (o?.source ? `${k}:${o.source}` : k) }),
}));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/GlassSurface', () => ({
    GLASS_OVER_CONTENT_FILL: '#111',
    TranslucentPlate: () => null,
}));
jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
const mockToastShow = jest.fn();
jest.mock('@/components/ui/toast', () => ({
    Toast: ({ children }: any) => children,
    ToastTitle: ({ children }: any) => children,
    useToast: () => ({ show: mockToastShow, close: jest.fn() }),
}));
const mockTrackPress = jest.fn();
jest.mock('@/components/custom/tracked-stories/use-track-button', () => ({
    useTrackButton: () => ({ tracked: false, onPress: mockTrackPress, dialog: null }),
}));
const mockAsk = jest.fn(() => true);
jest.mock('@/components/custom/floating-chat/ask-mera', () => ({
    askMeraAbout: (...a: any[]) => mockAsk(...a),
}));
const mockSetPref = jest.fn(async () => ({ applied: true }));
jest.mock('@/lib/database/services/publication-pref-ui-actions', () => ({
    setSourcePrefFromUi: (...a: any[]) => mockSetPref(...a),
}));
const mockShowFeedback = jest.fn();
jest.mock('@/lib/feedback', () => ({ showFeedback: (...a: any[]) => mockShowFeedback(...a) }));
let mockSentry = true;
jest.mock('@/lib/sentry-init', () => ({
    get SENTRY_ENABLED() {
        return mockSentry;
    },
}));
jest.mock('@/lib/stores/app-language-store', () => ({ useAppLanguage: () => 'en' }));
const mockOpenOnSource = jest.fn(async () => true);
jest.mock('@/components/custom/cards/article-actions', () => ({
    openOnSource: (...a: any[]) => mockOpenOnSource(...a),
    openInGoogleTranslate: jest.fn(async () => true),
    isForeignLanguage: (lang: string | null, app: string | null) =>
        !lang || !app || lang.split('-')[0] !== app.split('-')[0],
}));

import { MENU_CLOSE_MS, useArticleMenu, type UseArticleMenuInput } from '../use-article-menu';

const subject = {
    origin: 'suggestion' as const,
    surface: 'for_you',
    articleId: 'art-1',
    suggestionId: 'sug-1',
    title: 'A headline',
    publicationName: 'NOS',
};

function Host(props: Partial<UseArticleMenuInput>) {
    const menu = useArticleMenu({
        surface: 'card',
        subject,
        articleUrl: 'https://nos.nl/a',
        languageCode: 'nl',
        ...props,
    });
    const { Pressable, Text } = require('react-native');
    return (
        <>
            <Pressable testID="open" onPress={menu.open}>
                <Text>open</Text>
            </Pressable>
            {menu.element}
        </>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockSentry = true;
});
afterEach(() => jest.useRealTimers());

const openMenu = (ui: React.ReactElement) => {
    const r = render(ui);
    fireEvent.press(r.getByTestId('open'));
    return r;
};

describe('useArticleMenu items', () => {
    it('offers the full set on a card for a foreign-language article', () => {
        const r = openMenu(<Host onCheckFacts={jest.fn()} />);
        for (const id of [
            'card-action-mera',
            'card-action-track',
            'card-action-fact-check',
            'menu-open-source',
            'menu-open-translate',
            'menu-fewer-from-source',
            'menu-report-bug',
            'article-menu-cancel',
        ]) {
            expect(r.getByTestId(id)).toBeTruthy();
        }
        expect(r.getByText('articleMenu.openOn:NOS')).toBeTruthy();
    });

    it('omits Open on source on the detail screen, where it is the main button', () => {
        const r = openMenu(<Host surface="detail" />);
        expect(r.queryByTestId('menu-open-source')).toBeNull();
    });

    it('omits Google Translate for an article already in the reader\'s language', () => {
        const r = openMenu(<Host languageCode="en" />);
        expect(r.queryByTestId('menu-open-translate')).toBeNull();
    });

    it('omits Report a bug when Sentry is off, so the item never does nothing', () => {
        mockSentry = false;
        const r = openMenu(<Host />);
        expect(r.queryByTestId('menu-report-bug')).toBeNull();
    });

    it('omits Check for fact checks when the surface cannot start one', () => {
        const r = openMenu(<Host />);
        expect(r.queryByTestId('card-action-fact-check')).toBeNull();
    });
});

describe('useArticleMenu running items', () => {
    it('runs an item only after the sheet has closed', () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-report-bug'));
        expect(r.queryByTestId('article-menu')).toBeNull();
        expect(mockShowFeedback).not.toHaveBeenCalled();
        act(() => {
            jest.advanceTimersByTime(MENU_CLOSE_MS);
        });
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
        // No article id or URL is ever handed to the bug report.
        expect(mockShowFeedback).toHaveBeenCalledWith();
    });

    it('opens on source through the shared helper that records the visit', async () => {
        const visit = { publicationName: 'NOS', articleId: 'art-1' };
        const r = openMenu(<Host visit={visit} />);
        fireEvent.press(r.getByTestId('menu-open-source'));
        await act(async () => {
            jest.advanceTimersByTime(MENU_CLOSE_MS);
        });
        expect(mockOpenOnSource).toHaveBeenCalledWith('https://nos.nl/a', visit);
    });

    it('says so, with a retry, when an item fails', async () => {
        mockAsk.mockReturnValueOnce(false);
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('card-action-mera'));
        await act(async () => {
            jest.advanceTimersByTime(MENU_CLOSE_MS);
        });
        expect(mockToastShow).toHaveBeenCalledTimes(1);
    });

    it('turns a source down with an undo, never silently', async () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-fewer-from-source'));
        await act(async () => {
            jest.advanceTimersByTime(MENU_CLOSE_MS);
        });
        expect(mockSetPref).toHaveBeenCalledWith({ kind: 'publication', publicationName: 'NOS' }, 'deprioritised');
        expect(mockToastShow).toHaveBeenCalledTimes(1);
    });
});
