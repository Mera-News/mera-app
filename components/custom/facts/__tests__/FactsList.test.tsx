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
        default: ({ fact, onDeletePress, onToggle, capped, unlocked }: any) => (
            <View>
                <Text>{fact.statement}</Text>
                <Text>{`state-${fact.id}-${!capped ? 'uncapped' : unlocked ? 'live' : 'paused'}`}</Text>
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
// Settable so a test can reproduce the state this component has to survive:
// signed in, but the server session could not be fetched.
const mockSessionRef = { current: { user: { id: 'u1' } } as { user: { id: string } } | null };
jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: mockSessionRef.current }) },
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

// Selector-shaped: the component reads the LOCAL identity via
// `useUserStore((s) => s.userId)` AND destructures actions off a bare call.
const mockFetchUserPersona = jest.fn();
const mockLocalUserIdRef = { current: 'u1' as string | null };
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: (selector?: (s: unknown) => unknown) => {
        const state = { userId: mockLocalUserIdRef.current, fetchUserPersona: mockFetchUserPersona };
        return selector ? selector(state) : state;
    },
}));

jest.mock('@/lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn() } }));

// Stubbed because it imports `components/ui/button`, which reaches
// ActivityIndicator and fails this suite at IMPORT, not at render.
jest.mock('@/components/custom/subscription/FreeTierExplainerSheet', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('@/components/ui/text', () => ({
    Text: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
}));
jest.mock('@/components/ui/vstack', () => ({
    VStack: (p: any) => { const { View } = require('react-native'); return <View {...p} />; },
}));

const mockAiAccessRef = { current: 'entitled' as 'entitled' | 'locked' | 'unknown' };
jest.mock('@/lib/stores/subscription-store', () => ({
    useAiAccess: () => mockAiAccessRef.current,
    getAiAccess: () => mockAiAccessRef.current,
    useSubscriptionStore: { getState: () => ({ serverTier: null }) },
}));

import FactsList from '../FactsList';

beforeEach(() => {
    jest.clearAllMocks();
    mockSessionRef.current = { user: { id: 'u1' } };
    mockLocalUserIdRef.current = 'u1';
    mockAiAccessRef.current = 'entitled';
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

    // Offline / keychain-locked wake / 401 blip. Facts are device-local and the
    // user never logged out, so their own facts must stay editable — the delete
    // used to return silently because it was gated on `session.user.id`.
    it('deletes a fact while the server session cannot be fetched', async () => {
        mockSessionRef.current = null;
        mockGetFacts.mockResolvedValueOnce([{ id: 'f1', statement: 'Lives in Pune' }]);
        mockDeleteFact.mockResolvedValue(undefined);
        mockGetFacts.mockResolvedValueOnce([]);

        const { getByText, getByLabelText } = render(<FactsList />);
        await waitFor(() => expect(getByText('Lives in Pune')).toBeTruthy());

        fireEvent.press(getByLabelText('delete-f1'));
        fireEvent.press(getByLabelText('confirm-delete'));

        await waitFor(() => expect(mockDeleteFact).toHaveBeenCalledWith('f1'));
        // The persona refresh still runs — off the LOCAL id, not the session.
        expect(mockFetchUserPersona).toHaveBeenCalledWith('u1', true);
    });

    // No identity anywhere (a genuinely logged-out device): the local write is
    // still allowed, only the server-side persona refresh is skipped.
    it('deletes locally without a persona refresh when no identity exists at all', async () => {
        mockSessionRef.current = null;
        mockLocalUserIdRef.current = null;
        mockGetFacts.mockResolvedValueOnce([{ id: 'f1', statement: 'Lives in Pune' }]);
        mockDeleteFact.mockResolvedValue(undefined);
        mockGetFacts.mockResolvedValueOnce([]);

        const { getByText, getByLabelText } = render(<FactsList />);
        await waitFor(() => expect(getByText('Lives in Pune')).toBeTruthy());

        fireEvent.press(getByLabelText('delete-f1'));
        fireEvent.press(getByLabelText('confirm-delete'));

        await waitFor(() => expect(mockDeleteFact).toHaveBeenCalledWith('f1'));
        expect(mockFetchUserPersona).not.toHaveBeenCalled();
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

    // --- Mera News Free: the two-oldest-facts cap -----------------------
    describe('free tier', () => {
        const threeFacts = [
            { id: 'new', statement: 'Newest interest', createdAt: '2026-03-01T00:00:00.000Z', metadata: { topics: ['Formula 1'] } },
            { id: 'old', statement: 'Oldest interest', createdAt: '2026-01-01T00:00:00.000Z', metadata: { topics: ['Lisbon'] } },
            { id: 'mid', statement: 'Middle interest', createdAt: '2026-02-01T00:00:00.000Z', metadata: { topics: ['Energy'] } },
        ];

        it('renders no free-tier chrome for an entitled user', async () => {
            mockGetFacts.mockResolvedValue(threeFacts);
            const { queryByTestId, getByText } = render(<FactsList />);
            await waitFor(() => expect(getByText('Oldest interest')).toBeTruthy());
            expect(queryByTestId('facts-header-in-feed')).toBeNull();
            expect(queryByTestId('facts-header-paused')).toBeNull();
            expect(getByText('state-old-uncapped')).toBeTruthy();
        });

        it('groups the two OLDEST facts as live and the rest as paused', async () => {
            mockAiAccessRef.current = 'locked';
            mockGetFacts.mockResolvedValue(threeFacts);
            const { getByTestId, getByText } = render(<FactsList />);
            await waitFor(() => expect(getByText('Oldest interest')).toBeTruthy());

            expect(getByTestId('facts-header-in-feed')).toBeTruthy();
            expect(getByTestId('facts-header-paused')).toBeTruthy();
            // Oldest two live, newest paused -- by creation time, not list order.
            expect(getByText('state-old-live')).toBeTruthy();
            expect(getByText('state-mid-live')).toBeTruthy();
            expect(getByText('state-new-paused')).toBeTruthy();
        });

        it('puts the live facts ABOVE the paused ones', async () => {
            mockAiAccessRef.current = 'locked';
            mockGetFacts.mockResolvedValue(threeFacts);
            const { getAllByText, getByText } = render(<FactsList />);
            await waitFor(() => expect(getByText('Oldest interest')).toBeTruthy());
            // getFacts() sorts NEWEST first, so without the reorder the live
            // facts would render at the bottom of the list.
            const order = getAllByText(/^state-/).map((n) => n.props.children);
            expect(order).toEqual(['state-old-live', 'state-mid-live', 'state-new-paused']);
        });

        it('still groups correctly when the device holds only one fact', async () => {
            mockAiAccessRef.current = 'locked';
            mockGetFacts.mockResolvedValue([threeFacts[1]]);
            const { getByTestId, queryByTestId, getByText } = render(<FactsList />);
            await waitFor(() => expect(getByText('Oldest interest')).toBeTruthy());
            expect(getByTestId('facts-header-in-feed')).toBeTruthy();
            // Nothing is paused, so that header must not appear.
            expect(queryByTestId('facts-header-paused')).toBeNull();
            expect(getByText('state-old-live')).toBeTruthy();
        });
    });
});
