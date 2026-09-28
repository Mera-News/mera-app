/* eslint-disable @typescript-eslint/no-require-imports */
// WhatMeraKeepsCard: the "What Mera keeps about you" row on Manage data.
//
// What must hold:
//  - collapsed by default, one row; expanding shows at most four lines;
//  - the lines follow the ACCOUNT: an email line only with an email, a
//    sign-in record line only without one;
//  - when the account cannot be told (store not hydrated, offline, no
//    session) it shows the generic list, never a spinner and never an error;
//  - the Support ID shows with its copy button when the session carries one.

import { act, fireEvent, render } from '@testing-library/react-native';
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
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable: (p: any) => <Pressable {...p} /> }; });
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (k: string, o?: Record<string, unknown>) => (o?.id ? `${k}:${o.id}` : k),
    }),
}));

let mockSessionUser: Record<string, unknown> | null = null;
jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: mockSessionUser ? { user: mockSessionUser } : null }) },
}));
// Module-level value, never an inline object: the selector's result must be
// stable across renders (see the skill's jest.mock factory trap).
let mockStoredEmail: string | null = null;
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: (sel: (s: { userEmail: string | null }) => unknown) => sel({ userEmail: mockStoredEmail }),
}));
jest.mock('@/lib/config/branding', () => ({ PRIVACY_URL: 'https://mera.news/privacy' }));
const mockOpen = jest.fn();
jest.mock('@/lib/web-browser-utils', () => ({ openInAppBrowser: (...a: unknown[]) => mockOpen(...a) }));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(async () => {}) }));
const mockSetString = jest.fn(async (_s: string) => {});
jest.mock('expo-clipboard', () => ({ setStringAsync: (s: string) => mockSetString(s) }));

import { Platform } from 'react-native';

import WhatMeraKeepsCard, { keepsAccountKind, keepsLineKeys } from '../WhatMeraKeepsCard';

const originalOS = Platform.OS;

beforeEach(() => {
    jest.clearAllMocks();
    mockSessionUser = null;
    mockStoredEmail = null;
    (Platform as { OS: string }).OS = 'ios';
});

afterAll(() => {
    (Platform as { OS: string }).OS = originalOS;
});

function lineIds(r: ReturnType<typeof render>): string[] {
    return r
        .UNSAFE_root.findAll((n: any) => typeof n.props?.testID === 'string' && n.props.testID.startsWith('manage-data-keeps-line-'))
        .map((n: any) => n.props.testID.replace('manage-data-keeps-line-', ''))
        .filter((id: string, i: number, all: string[]) => all.indexOf(id) === i);
}

function expand(r: ReturnType<typeof render>) {
    fireEvent.press(r.getByTestId('manage-data-keeps-toggle'));
}

describe('keepsAccountKind', () => {
    it('a real stored email is an email account, even offline', () => {
        expect(keepsAccountKind('a@b.com', null)).toBe('email');
    });
    it('an anonymous session is an account without email', () => {
        expect(keepsAccountKind(null, { email: 'temp-1@anon.mera.news' })).toBe('no-email');
        expect(keepsAccountKind(null, { isAnonymous: true })).toBe('no-email');
    });
    it('a session with a real email is an email account', () => {
        expect(keepsAccountKind(null, { email: 'a@b.com' })).toBe('email');
    });
    it('nothing on hand is unknown, never "no email"', () => {
        expect(keepsAccountKind(null, null)).toBe('unknown');
        expect(keepsAccountKind(null, {})).toBe('unknown');
    });
});

describe('keepsLineKeys', () => {
    it('never lists more than four lines', () => {
        for (const kind of ['email', 'no-email', 'unknown'] as const) {
            for (const os of ['ios', 'android']) {
                expect(keepsLineKeys(kind, os).length).toBeLessThanOrEqual(4);
            }
        }
    });
    it('every key exists in en.json', () => {
        const en = require('../../../../lib/locales/en.json');
        const get = (k: string) => k.split('.').reduce((o: any, p) => o?.[p], en);
        for (const kind of ['email', 'no-email', 'unknown'] as const) {
            for (const os of ['ios', 'android']) {
                for (const k of keepsLineKeys(kind, os)) expect(typeof get(k)).toBe('string');
            }
        }
    });
});

describe('WhatMeraKeepsCard', () => {
    it('starts collapsed: one row, no lines', () => {
        const r = render(<WhatMeraKeepsCard />);
        expect(r.getByTestId('manage-data-keeps-toggle').props.accessibilityState).toEqual({ expanded: false });
        expect(r.queryByTestId('manage-data-keeps-body')).toBeNull();
    });

    it('an email account: the email line, and no sign-in record line', () => {
        mockStoredEmail = 'a@b.com';
        const r = render(<WhatMeraKeepsCard />);
        expand(r);
        expect(r.getByTestId('manage-data-keeps-toggle').props.accessibilityState).toEqual({ expanded: true });
        expect(lineIds(r)).toEqual(['emailAndPlan', 'usage', 'topics']);
    });

    it('an account without email on iPhone: plan, the iPhone sign-in record, usage, topics', () => {
        mockSessionUser = { email: 'temp-1@anon.mera.news' };
        const r = render(<WhatMeraKeepsCard />);
        expand(r);
        expect(lineIds(r)).toEqual(['plan', 'signInRecordIos', 'usage', 'topics']);
    });

    it('an account without email on Android names the Android record', () => {
        (Platform as { OS: string }).OS = 'android';
        mockSessionUser = { email: 'temp-1@anon.mera.news' };
        const r = render(<WhatMeraKeepsCard />);
        expand(r);
        expect(lineIds(r)).toEqual(['plan', 'signInRecordAndroid', 'usage', 'topics']);
    });

    it('an unhydrated store with no session shows the generic list, with no spinner or error', () => {
        const r = render(<WhatMeraKeepsCard />);
        expand(r);
        expect(lineIds(r)).toEqual(['emailIfAdded', 'signInRecordGeneric', 'usage', 'topics']);
        expect(r.queryByTestId('manage-data-keeps-support-id')).toBeNull();
    });

    it('shows the Support ID from the session and copies only the id', async () => {
        mockSessionUser = { email: 'temp-1@anon.mera.news', supportId: '1234567' };
        const r = render(<WhatMeraKeepsCard />);
        expand(r);
        expect(r.getByTestId('manage-data-keeps-support-id').props.children).toBe('support.supportId:1234567');
        await act(async () => {
            fireEvent.press(r.getByTestId('manage-data-keeps-support-id-copy'));
        });
        expect(mockSetString).toHaveBeenCalledWith('1234567');
        expect(r.getByTestId('manage-data-keeps-support-id-copy').props.accessibilityLabel).toBe('support.copied');
    });

    it('the privacy link opens the unprefixed privacy policy', () => {
        const r = render(<WhatMeraKeepsCard />);
        expand(r);
        fireEvent.press(r.getByTestId('manage-data-keeps-privacy'));
        expect(mockOpen).toHaveBeenCalledWith('https://mera.news/privacy');
    });
});
