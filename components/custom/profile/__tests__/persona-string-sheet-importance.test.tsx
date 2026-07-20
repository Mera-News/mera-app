/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, o?: any) => o?.defaultValue ?? _k }),
}));

// jest-expo mis-transforms some RN native-component files; the sheet only needs
// Modal to render its children when visible. Proxy RN so Modal → passthrough
// View; every other export stays real (the ui mocks read View/Pressable/Text).
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'Modal') {
                return ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
            }
            return (target as any)[prop];
        },
    });
});

// --- gluestack ui + icons → RN primitives ---------------------------------
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> };
});

// --- services / stores ------------------------------------------------------
const mockGetWeightsByIds = jest.fn();
jest.mock('@/lib/database/services/topic-service', () => ({
    getWeightsByIds: (...a: unknown[]) => mockGetWeightsByIds(...a),
}));

const mockNudgeTopic = jest.fn();
jest.mock('@/lib/database/services/mutation-rails-service', () => ({
    nudgeTopic: (...a: unknown[]) => mockNudgeTopic(...a),
}));

jest.mock('@/lib/database/services/persona-summary-service', () => ({
    deleteSummaryString: jest.fn(),
}));
jest.mock('@/lib/chat-tools/tool-handlers', () => ({ handleDeleteUserFacts: jest.fn() }));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn(), hapticSuccess: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));
jest.mock('@/lib/stores/floating-chat-store', () => ({
    useFloatingChatStore: { getState: () => ({ openArticleFeedback: jest.fn() }) },
}));

const mockSetFeedNeedsRefresh = jest.fn();
jest.mock('@/lib/stores/for-you-store', () => ({
    useForYouStore: { getState: () => ({ setFeedNeedsRefresh: mockSetFeedNeedsRefresh }) },
}));

import PersonaStringSheet from '../PersonaStringSheet';

const baseRow = {
    id: 's1',
    text: 'Lives in Pune with family',
    linkedFactIds: ['f1'],
    linkedTopicIds: ['t1', 't2'],
    generatedAt: 1,
    personaVersion: 'v',
    stale: false,
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe('PersonaStringSheet — importance stepper', () => {
    it('hides the stepper when no linked topics resolve (all stale)', async () => {
        mockGetWeightsByIds.mockResolvedValue([]);
        const { queryByLabelText, getByText } = render(
            <PersonaStringSheet visible row={baseRow as any} onClose={jest.fn()} />,
        );
        // The string still renders...
        await waitFor(() => expect(getByText('Lives in Pune with family')).toBeTruthy());
        // ...but the +/- buttons are gone (no dead buttons on stale ids).
        expect(queryByLabelText('More important')).toBeNull();
        expect(queryByLabelText('Less important')).toBeNull();
    });

    it('shows the stepper when at least one topic resolves', async () => {
        mockGetWeightsByIds.mockResolvedValue([{ id: 't1', weight: 0.4 }]);
        const { getByLabelText } = render(
            <PersonaStringSheet visible row={baseRow as any} onClose={jest.fn()} />,
        );
        await waitFor(() => expect(getByLabelText('More important')).toBeTruthy());
    });

    it('shows the limit-reached hint when nothing applied (budget exhausted)', async () => {
        mockGetWeightsByIds.mockResolvedValue([{ id: 't1', weight: 0.4 }]);
        mockNudgeTopic.mockResolvedValue({ applied: false, after: 0.4 });
        const { getByLabelText, getByText } = render(
            <PersonaStringSheet visible row={baseRow as any} onClose={jest.fn()} />,
        );
        await waitFor(() => expect(getByLabelText('More important')).toBeTruthy());

        fireEvent.press(getByLabelText('More important'));

        await waitFor(() =>
            expect(getByText('Daily adjustment limit reached — changes continue tomorrow.')).toBeTruthy(),
        );
        expect(mockSetFeedNeedsRefresh).not.toHaveBeenCalled();
    });

    it('refreshes the feed and shows no hint when a nudge applies', async () => {
        mockGetWeightsByIds.mockResolvedValue([{ id: 't1', weight: 0.4 }]);
        mockNudgeTopic.mockResolvedValue({ applied: true, after: 0.45 });
        const { getByLabelText, queryByText } = render(
            <PersonaStringSheet visible row={baseRow as any} onClose={jest.fn()} />,
        );
        await waitFor(() => expect(getByLabelText('More important')).toBeTruthy());

        fireEvent.press(getByLabelText('More important'));

        await waitFor(() => expect(mockSetFeedNeedsRefresh).toHaveBeenCalledWith(true));
        expect(queryByText('Daily adjustment limit reached — changes continue tomorrow.')).toBeNull();
    });
});
