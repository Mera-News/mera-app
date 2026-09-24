/* eslint-disable @typescript-eslint/no-require-imports */
// The shared ••• menu (D3): which items appear where, that items run AFTER the
// sheet closes, that a failure offers a retry, and that Report a bug carries no
// article context.
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

let mockModal: any = null;
let mockOS = 'ios';
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'Modal') {
                // Records its props so a test can play the native dismissal
                // (`onDismiss`, iOS only) at the moment it chooses.
                return (props: any) => {
                    mockModal = props;
                    return props.visible === false
                        ? null
                        : ReactLib.createElement(ReactLib.Fragment, null, props.children);
                };
            }
            if (prop === 'Platform') return { ...actual.Platform, OS: mockOS };
            return (target as any)[prop];
        },
    });
});
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (k: string, o?: Record<string, string>) => (o?.source ? `${k}:${o.source}` : k),
        i18n: { language: 'en' },
    }),
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
const mockAsk = jest.fn((..._a: any[]) => true);
jest.mock('@/components/custom/floating-chat/ask-mera', () => ({
    askMeraAbout: (...a: any[]) => mockAsk(...a),
}));
const mockSetPref = jest.fn(async (..._a: any[]) => ({ applied: true }));
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
const mockOpenOnSource = jest.fn(async (..._a: any[]) => true);
jest.mock('@/components/custom/cards/article-actions', () => ({
    openOnSource: (...a: any[]) => mockOpenOnSource(...a),
    openInGoogleTranslate: jest.fn(async () => true),
    isForeignLanguage: (lang: string | null, app: string | null) =>
        !lang || !app || lang.split('-')[0] !== app.split('-')[0],
}));

import { MENU_DISMISS_FALLBACK_MS, useArticleMenu, type UseArticleMenuInput } from '../use-article-menu';

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
    mockModal = null;
    mockOS = 'ios';
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

describe('ArticleOverflowMenu sheet', () => {
    it('titles the sheet with the headline, not a generic label', () => {
        const r = openMenu(<Host />);
        expect(r.getByTestId('article-menu-title').props.children).toBe('A headline');
        expect(r.getByTestId('article-menu-title').props.numberOfLines).toBe(1);
    });

    it('clears the home indicator and gives Cancel its own readable plate', () => {
        const r = openMenu(<Host />);
        const { StyleSheet } = require('react-native');
        expect(StyleSheet.flatten(r.getByTestId('article-menu').props.style).paddingBottom).toBe(34 + 12);
        // The plate is a STATIC style on an inner View: a function style on the
        // Pressable itself was dropped on device (740).
        const plate = StyleSheet.flatten(r.getByTestId('article-menu-cancel-plate').props.style);
        expect(plate).toEqual(
            expect.objectContaining({ minHeight: 48, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.10)' }),
        );
    });
});

// The browser bug: an item that presents native UI (SFSafariViewController,
// the feedback form) while the RN Modal is still dismissing is silently
// dropped on iOS, and its await never resolves. Items run AFTER the Modal
// reports it is gone: `onDismiss` on iOS, visible -> false on Android, with a
// fallback and an unmount flush, exactly once. Never on a timer guess.
const dismiss = () =>
    act(() => {
        mockModal?.onDismiss?.();
    });
const flushAsync = async () => {
    await act(async () => {
        await Promise.resolve();
    });
};

describe('useArticleMenu running items', () => {
    it('iOS: keeps the Modal mounted while it dismisses and runs the item on onDismiss, not on a timer', () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-report-bug'));
        expect(mockModal.visible).toBe(false);
        expect(typeof mockModal.onDismiss).toBe('function');
        act(() => {
            jest.advanceTimersByTime(250);
        });
        expect(mockShowFeedback).not.toHaveBeenCalled();
        dismiss();
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
        // No article id or URL is ever handed to the bug report.
        expect(mockShowFeedback).toHaveBeenCalledWith();
        dismiss();
        act(() => {
            jest.advanceTimersByTime(MENU_DISMISS_FALLBACK_MS);
        });
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
    });

    it('iOS: runs the item once at the fallback when onDismiss never comes', () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-report-bug'));
        act(() => {
            jest.advanceTimersByTime(MENU_DISMISS_FALLBACK_MS - 1);
        });
        expect(mockShowFeedback).not.toHaveBeenCalled();
        act(() => {
            jest.advanceTimersByTime(1);
        });
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
        dismiss();
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
    });

    it('Android: runs the item once the Modal is hidden (no onDismiss there)', () => {
        mockOS = 'android';
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-report-bug'));
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
        act(() => {
            jest.advanceTimersByTime(MENU_DISMISS_FALLBACK_MS);
        });
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
    });

    it('runs a picked item once when the host unmounts mid-dismissal', () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-report-bug'));
        r.unmount();
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
        act(() => {
            jest.advanceTimersByTime(MENU_DISMISS_FALLBACK_MS);
        });
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
    });

    it('Cancel runs nothing and unmounts the sheet after the dismissal', () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('article-menu-cancel'));
        dismiss();
        expect(mockShowFeedback).not.toHaveBeenCalled();
        expect(mockOpenOnSource).not.toHaveBeenCalled();
    });

    it('opens on source through the shared helper that records the visit', async () => {
        const visit = { publicationName: 'NOS', countryCode: 'NL', articleId: 'art-1' };
        const r = openMenu(<Host visit={visit} />);
        fireEvent.press(r.getByTestId('menu-open-source'));
        expect(mockOpenOnSource).not.toHaveBeenCalled();
        dismiss();
        await flushAsync();
        expect(mockOpenOnSource).toHaveBeenCalledTimes(1);
        expect(mockOpenOnSource).toHaveBeenCalledWith('https://nos.nl/a', visit);
    });

    it('opens Google Translate the same way, after the dismissal', async () => {
        const { openInGoogleTranslate } = require('@/components/custom/cards/article-actions');
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-open-translate'));
        expect(openInGoogleTranslate).not.toHaveBeenCalled();
        dismiss();
        await flushAsync();
        expect(openInGoogleTranslate).toHaveBeenCalledTimes(1);
        expect(openInGoogleTranslate).toHaveBeenCalledWith('https://nos.nl/a', 'en');
    });

    it('says so, with a retry, when an item fails', async () => {
        mockAsk.mockReturnValueOnce(false);
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('card-action-mera'));
        dismiss();
        await flushAsync();
        expect(mockToastShow).toHaveBeenCalledTimes(1);
    });

    it('turns a source down with an undo, never silently', async () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-fewer-from-source'));
        dismiss();
        await flushAsync();
        await flushAsync();
        expect(mockSetPref).toHaveBeenCalledWith({ kind: 'publication', publicationName: 'NOS' }, 'deprioritised');
        expect(mockToastShow).toHaveBeenCalledTimes(1);
    });
});
