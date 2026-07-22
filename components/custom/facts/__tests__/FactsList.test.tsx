/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, o?: any) => o?.defaultValue ?? _k }),
}));

jest.mock('expo-router', () => ({
    router: { push: jest.fn() },
}));

jest.mock('@/components/ui/toast', () => ({
    useToast: () => ({ show: jest.fn() }),
    Toast: (p: any) => { const { View } = require('react-native'); return <View {...p} />; },
    ToastTitle: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
    ToastDescription: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
}));

// --- child components → light stubs, wired to the same handler props FactsList passes. ---
jest.mock('../FactAccordion', () => {
    const { View, Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ fact, onDeletePress, onToggle }: any) => (
            <View>
                <Text>{fact.statement}</Text>
                <Pressable accessibilityLabel={`delete-${fact.id}`} onPress={() => onDeletePress(fact)} />
                <Pressable accessibilityLabel={`toggle-${fact.id}`} onPress={() => onToggle(fact.id)} />
            </View>
        ),
    };
});
jest.mock('../DeleteFactModal', () => {
    const { View, Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ fact, onConfirm, onCancel }: any) =>
            fact ? (
                <View>
                    <Text>{`confirm-delete:${fact.id}`}</Text>
                    <Pressable accessibilityLabel="confirm-delete" onPress={onConfirm} />
                    <Pressable accessibilityLabel="cancel-delete" onPress={onCancel} />
                </View>
            ) : null,
    };
});
jest.mock('../AddTopicModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../GenerateMoreModal', () => ({ __esModule: true, default: () => null }));

// --- services / stores ------------------------------------------------------
jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: { user: { id: 'u1' } } }) },
}));

const mockGetFacts = jest.fn();
const mockDeleteFact = jest.fn();
const mockUpdateFact = jest.fn();
jest.mock('@/lib/database/services/fact-service', () => ({
    getFacts: (...a: unknown[]) => mockGetFacts(...a),
    deleteFact: (...a: unknown[]) => mockDeleteFact(...a),
    updateFact: (...a: unknown[]) => mockUpdateFact(...a),
}));

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    getArticleCountByTopicTexts: () => Promise.resolve(new Map()),
}));

jest.mock('@/lib/database/services/inference-job-service', () => ({
    enqueueJob: jest.fn(),
}));

jest.mock('@/lib/inference/handlers/topic-gen-handler', () => ({
    buildTopicGenContext: () => ({ userLocation: null, otherFacts: [] }),
}));

jest.mock('@/lib/inference/InferenceQueue', () => ({
    inferenceQueue: { onDrain: jest.fn(), notify: jest.fn() },
}));

jest.mock('@/lib/mera-protocol/topic-generation-service', () => ({
    generateTopicsForFact: jest.fn(),
    mergeTopicsAppend: (a: string[], b: string[]) => [...a, ...b],
}));

jest.mock('@/lib/stores/floating-chat-store', () => ({
    useFloatingChatFactMutationVersion: () => 0,
    useFloatingChatIsExpanded: () => false,
}));

jest.mock('@/lib/stores/for-you-store', () => ({
    useForYouStore: { getState: () => ({ setFeedNeedsRefresh: jest.fn() }) },
}));

jest.mock('@/lib/stores/mera-protocol-store', () => ({
    useIsOnDeviceProcessing: () => false,
}));

const mockFetchUserPersona = jest.fn();
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: () => ({ fetchUserPersona: mockFetchUserPersona }),
}));

jest.mock('@/lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn() } }));

import FactsList from '../FactsList';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('FactsList', () => {
    it('renders one row per fact', async () => {
        mockGetFacts.mockResolvedValue([
            { id: 'f1', statement: 'Lives in Pune' },
            { id: 'f2', statement: 'Works at Acme' },
        ]);
        const { getByText } = render(<FactsList />);
        await waitFor(() => expect(getByText('Lives in Pune')).toBeTruthy());
        expect(getByText('Works at Acme')).toBeTruthy();
    });

    it('delete flow: trash press opens DeleteFactModal, confirm calls deleteFact and reloads', async () => {
        mockGetFacts.mockResolvedValueOnce([{ id: 'f1', statement: 'Lives in Pune' }]);
        mockDeleteFact.mockResolvedValue(undefined);
        mockGetFacts.mockResolvedValueOnce([]);

        const { getByText, getByLabelText, queryByText } = render(<FactsList />);
        await waitFor(() => expect(getByText('Lives in Pune')).toBeTruthy());

        fireEvent.press(getByLabelText('delete-f1'));
        expect(getByText('confirm-delete:f1')).toBeTruthy();

        fireEvent.press(getByLabelText('confirm-delete'));

        await waitFor(() => expect(mockDeleteFact).toHaveBeenCalledWith('f1'));
        await waitFor(() => expect(queryByText('confirm-delete:f1')).toBeNull());
    });

    it('reports loading/loaded facts back via onFactsChange', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Lives in Pune' }]);
        const onFactsChange = jest.fn();
        render(<FactsList onFactsChange={onFactsChange} />);

        expect(onFactsChange).toHaveBeenCalledWith(null);
        await waitFor(() =>
            expect(onFactsChange).toHaveBeenCalledWith([{ id: 'f1', statement: 'Lives in Pune' }]),
        );
    });
});
