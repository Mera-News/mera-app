// WhatsNewSheet — the GATE, which is the part that fails silently.
//
// Both mechanics pinned here are product decisions, not implementation detail,
// and both fail invisibly if broken: a wrong settings key shows the
// announcement to nobody, and a missing fresh-install branch shows a
// before-and-after modal to someone with no "before".
//
// Only the data layer is mocked. The sheet's chrome is ordinary gluestack and
// renders fine under jest.

import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

const mockGetSetting = jest.fn<Promise<string | null>, [string]>();
const mockSetSetting = jest.fn<Promise<void>, [string, string]>(async () => {});
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => mockGetSetting(k),
    setSetting: (k: string, v: string) => mockSetSetting(k, v),
}));

const mockLoadFeedMetadata = jest.fn<Promise<unknown>, []>();
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    loadFeedMetadata: () => mockLoadFeedMetadata(),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
}));

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

// Gluestack primitives stubbed to plain RN. The real Button reaches
// ActivityIndicator, which this jest config cannot load (it is the same reason
// other suites in this directory stub the css-interop runtime). The gate is
// what this suite is about; the chrome is covered by rendering at all.
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: Pressable, ButtonText: Text };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    return {
        Modal: ({ isOpen, children }: any) => (isOpen ? <View>{children}</View> : null),
        ModalBackdrop: View,
        ModalBody: View,
        ModalContent: View,
        ModalFooter: View,
        ModalHeader: View,
    };
});
jest.mock('@/components/ui/box', () => ({ Box: require('react-native').View }));
jest.mock('@/components/ui/hstack', () => ({ HStack: require('react-native').View }));
jest.mock('@/components/ui/vstack', () => ({ VStack: require('react-native').View }));
jest.mock('@/components/ui/text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/heading', () => ({ Heading: require('react-native').Text }));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: require('react-native').View }));

import WhatsNewSheet from '../WhatsNewSheet';

/** The key this release must use. `whats_new_v3_seen` is already set for
 *  everyone who saw the v3 sheet, so reusing it would show this to nobody —
 *  and nothing at runtime would report that. */
const KEY = 'whats_new_starter_seen';

describe('WhatsNewSheet gate', () => {
    beforeEach(() => {
        mockGetSetting.mockReset();
        mockSetSetting.mockClear();
        mockLoadFeedMetadata.mockReset();
    });

    it('reads and writes the Starter key, never the v3 one', async () => {
        mockGetSetting.mockResolvedValue(null);
        mockLoadFeedMetadata.mockResolvedValue(null); // fresh install → writes
        render(<WhatsNewSheet />);

        await waitFor(() => expect(mockSetSetting).toHaveBeenCalled());
        expect(mockGetSetting).toHaveBeenCalledWith(KEY);
        expect(mockSetSetting).toHaveBeenCalledWith(KEY, '1');
        const touched = [
            ...mockGetSetting.mock.calls.map((c) => c[0]),
            ...mockSetSetting.mock.calls.map((c) => c[0]),
        ];
        expect(touched).not.toContain('whats_new_v3_seen');
    });

    it('shows the announcement to an existing user (feed metadata present)', async () => {
        mockGetSetting.mockResolvedValue(null);
        mockLoadFeedMetadata.mockResolvedValue({ lastRunAt: 1 });
        const { findByText } = render(<WhatsNewSheet />);

        expect(await findByText('whatsNew.starterTitle')).toBeTruthy();
        expect(await findByText('whatsNew.starterIntro')).toBeTruthy();
    });

    // Deliberate: the announcement is a before-and-after, and a brand-new user
    // has no "before". The flag is still written so it cannot surface later.
    it('never shows on a fresh install, but still writes the flag', async () => {
        mockGetSetting.mockResolvedValue(null);
        mockLoadFeedMetadata.mockResolvedValue(null);
        const { queryByText } = render(<WhatsNewSheet />);

        await waitFor(() => expect(mockSetSetting).toHaveBeenCalledWith(KEY, '1'));
        expect(queryByText('whatsNew.starterTitle')).toBeNull();
    });

    it('stays shut once the flag is set, without reading feed metadata', async () => {
        mockGetSetting.mockResolvedValue('1');
        const { queryByText } = render(<WhatsNewSheet />);

        await waitFor(() => expect(mockGetSetting).toHaveBeenCalledWith(KEY));
        expect(queryByText('whatsNew.starterTitle')).toBeNull();
        expect(mockLoadFeedMetadata).not.toHaveBeenCalled();
        expect(mockSetSetting).not.toHaveBeenCalled();
    });
});
