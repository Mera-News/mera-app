/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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

const mockFocusCallbacks: (() => void)[] = [];
jest.mock('expo-router', () => ({
    router: { push: jest.fn() },
    // Records the callback so a test can fire a "tab regained focus" later.
    useFocusEffect: (cb: () => void) => {
        const React2 = require('react');
        React2.useEffect(() => {
            mockFocusCallbacks.push(cb);
            cb();
        }, [cb]);
    },
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
        default: ({ fact, onDeletePress, onToggle, onDeleteTopic, onAddTopic, onGenerateMore, countState, editing, articleCountByTopic }: any) => (
            <View>
                <Text>{fact.statement}</Text>
                <Text testID={`count-state-${fact.id}`}>{`${countState}:${editing ? 'editing' : 'rest'}:${articleCountByTopic?.get?.('hiking') ?? 0}`}</Text>
                <Pressable accessibilityLabel={`delete-${fact.id}`} onPress={() => onDeletePress(fact)} />
                <Pressable accessibilityLabel={`toggle-${fact.id}`} onPress={() => onToggle(fact.id)} />
                <Pressable
                    accessibilityLabel={`delete-topic-${fact.id}`}
                    onPress={() => onDeleteTopic(fact, { id: 'topic-1', text: 'Mountain trail running' })}
                />
                <Pressable accessibilityLabel={`add-topic-${fact.id}`} onPress={() => onAddTopic(fact)} />
                <Pressable accessibilityLabel={`generate-more-${fact.id}`} onPress={() => onGenerateMore(fact)} />
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
jest.mock('../AddTopicModal', () => {
    const { View, Pressable, TextInput } = require('react-native');
    return {
        __esModule: true,
        default: ({ isOpen, value, onChangeText, onConfirm }: any) =>
            isOpen ? (
                <View>
                    <TextInput
                        testID="add-topic-input"
                        value={value}
                        onChangeText={onChangeText}
                    />
                    <Pressable accessibilityLabel="confirm-add-topic" onPress={onConfirm} />
                </View>
            ) : null,
    };
});
jest.mock('../GenerateMoreModal', () => {
    const { View, Pressable } = require('react-native');
    return {
        __esModule: true,
        default: ({ isOpen, onConfirm }: any) =>
            isOpen ? (
                <View>
                    <Pressable accessibilityLabel="confirm-generate-more" onPress={onConfirm} />
                </View>
            ) : null,
    };
});

// --- services / stores ------------------------------------------------------
// Settable so a test can reproduce the state this component has to survive:
// signed in, but the server session could not be fetched.
const mockSessionRef = { current: { user: { id: 'u1' } } as { user: { id: string } } | null };
jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: mockSessionRef.current }) },
}));

// observeFacts replaces the old one-shot getFacts() for the rendered array.
// Settable per test, with `emitFacts` for a SECOND emission simulating what
// the live subscription does on its own after a write (e.g. a delete making
// the fact disappear) — no test manually "reloads" any more.
type FactFixture = { id: string; statement: string };
let mockFacts: FactFixture[] = [];
let mockFactSubscribers: ((facts: FactFixture[]) => void)[] = [];
function emitFacts(facts: FactFixture[]) {
    mockFacts = facts;
    for (const cb of mockFactSubscribers) cb(facts);
}
// getFacts() itself survives as a one-shot read for handleGenerateMoreConfirm's
// on-device branch (building generation context) — unrelated to the list.
const mockGetFacts = jest.fn().mockResolvedValue([]);
const mockDeleteFact = jest.fn();
jest.mock('@/lib/database/services/fact-service', () => ({
    getFacts: (...a: unknown[]) => mockGetFacts(...a),
    deleteFact: (...a: unknown[]) => mockDeleteFact(...a),
    observeFacts: () => ({
        subscribe: (cb: (facts: FactFixture[]) => void) => {
            mockFactSubscribers.push(cb);
            cb(mockFacts);
            return {
                unsubscribe: () => {
                    mockFactSubscribers = mockFactSubscribers.filter((s) => s !== cb);
                },
            };
        },
    }),
}));

// B3 + the write-side fix: FactsList now calls the real topic-table
// primitives directly rather than rewriting fact.metadata. Mocked here for
// the same reason as fact-service — importing the real module constructs
// WatermelonDB's SQLite adapter, which has no native module under Jest.
const mockDeleteTopicWithDecline = jest.fn().mockResolvedValue({ undoToken: 't1' });
jest.mock('@/lib/database/services/topic-decline-service', () => ({
    deleteTopicWithDecline: (...a: unknown[]) => mockDeleteTopicWithDecline(...a),
}));

const mockCreateTopics = jest.fn().mockResolvedValue([]);
const mockSyncLlmTopicsForFact = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/database/services/topic-service', () => ({
    createTopics: (...a: unknown[]) => mockCreateTopics(...a),
    syncLlmTopicsForFact: (...a: unknown[]) => mockSyncLlmTopicsForFact(...a),
}));

const mockRenderableCounts = jest.fn((): Promise<Map<string, number>> => Promise.resolve(new Map()));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    getRenderableArticleCountByTopicTexts: () => mockRenderableCounts(),
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

let mockLastRunFinishedAt: number | null = null;
jest.mock('@/lib/stores/for-you-store', () => {
    const useForYouStore = (sel: (s: unknown) => unknown) =>
        sel({ lastProcessingRunFinishedAt: mockLastRunFinishedAt });
    useForYouStore.getState = () => ({ setFeedNeedsRefresh: jest.fn() });
    return { useForYouStore };
});

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

import FactsList from '../FactsList';

beforeEach(() => {
    jest.clearAllMocks();
    mockSessionRef.current = { user: { id: 'u1' } };
    mockLocalUserIdRef.current = 'u1';
    mockFacts = [];
    mockFactSubscribers = [];
    mockGetFacts.mockResolvedValue([]);
    mockFocusCallbacks.length = 0;
    mockLastRunFinishedAt = null;
    mockRenderableCounts.mockImplementation(() => Promise.resolve(new Map()));
});

describe('FactsList', () => {
    it('renders one row per fact', async () => {
        mockFacts = [
            { id: 'f1', statement: 'Lives in Pune' },
            { id: 'f2', statement: 'Works at Acme' },
        ];
        const { getByText } = render(<FactsList />);
        await waitFor(() => expect(getByText('Lives in Pune')).toBeTruthy());
        expect(getByText('Works at Acme')).toBeTruthy();
    });

    it('delete flow: trash press opens DeleteFactModal, confirm calls deleteFact; the row leaving is the live subscription\'s job, not a reload', async () => {
        mockFacts = [{ id: 'f1', statement: 'Lives in Pune' }];
        mockDeleteFact.mockResolvedValue(undefined);

        const { getByText, getByLabelText, queryByText } = render(<FactsList />);
        await waitFor(() => expect(getByText('Lives in Pune')).toBeTruthy());

        fireEvent.press(getByLabelText('delete-f1'));
        expect(getByText('confirm-delete:f1')).toBeTruthy();

        fireEvent.press(getByLabelText('confirm-delete'));

        await waitFor(() => expect(mockDeleteFact).toHaveBeenCalledWith('f1'));
        await waitFor(() => expect(queryByText('confirm-delete:f1')).toBeNull());

        // The component issues no reload of its own any more — it's the real
        // observeFacts subscription (mocked here) that would re-emit without
        // the destroyed row. Simulating that emission is what makes the row
        // actually disappear in this test.
        act(() => emitFacts([]));
        expect(queryByText('Lives in Pune')).toBeNull();
    });

    // Offline / keychain-locked wake / 401 blip. Facts are device-local and the
    // user never logged out, so their own facts must stay editable — the delete
    // used to return silently because it was gated on `session.user.id`.
    it('deletes a fact while the server session cannot be fetched', async () => {
        mockSessionRef.current = null;
        mockFacts = [{ id: 'f1', statement: 'Lives in Pune' }];
        mockDeleteFact.mockResolvedValue(undefined);

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
        mockFacts = [{ id: 'f1', statement: 'Lives in Pune' }];
        mockDeleteFact.mockResolvedValue(undefined);

        const { getByText, getByLabelText } = render(<FactsList />);
        await waitFor(() => expect(getByText('Lives in Pune')).toBeTruthy());

        fireEvent.press(getByLabelText('delete-f1'));
        fireEvent.press(getByLabelText('confirm-delete'));

        await waitFor(() => expect(mockDeleteFact).toHaveBeenCalledWith('f1'));
        expect(mockFetchUserPersona).not.toHaveBeenCalled();
    });

    it('reports loading/loaded facts back via onFactsChange', async () => {
        mockFacts = [{ id: 'f1', statement: 'Lives in Pune' }];
        const onFactsChange = jest.fn();
        render(<FactsList onFactsChange={onFactsChange} />);

        expect(onFactsChange).toHaveBeenCalledWith(null);
        await waitFor(() =>
            expect(onFactsChange).toHaveBeenCalledWith([{ id: 'f1', statement: 'Lives in Pune' }]),
        );
    });

    // B3's write side: these three now route onto the topics TABLE directly
    // (deleteTopicWithDecline / createTopics / syncLlmTopicsForFact) rather
    // than rewriting fact.metadata — see FactAccordion.test.tsx for the
    // matching read-side (observeByFact) coverage.
    it('deleteTopic routes through deleteTopicWithDecline with the topic ROW id, not a metadata rewrite', async () => {
        mockFacts = [{ id: 'f1', statement: 'Lives in Pune' }];
        const { getByText, getByLabelText } = render(<FactsList />);
        await waitFor(() => expect(getByText('Lives in Pune')).toBeTruthy());

        fireEvent.press(getByLabelText('delete-topic-f1'));

        await waitFor(() => expect(mockDeleteTopicWithDecline).toHaveBeenCalledWith('topic-1'));
        expect(mockFetchUserPersona).toHaveBeenCalledWith('u1', true);
    });

    it('addTopic routes through createTopics, not a metadata append', async () => {
        mockFacts = [{ id: 'f1', statement: 'Lives in Pune' }];
        const { getByText, getByLabelText, getByTestId } = render(<FactsList />);
        await waitFor(() => expect(getByText('Lives in Pune')).toBeTruthy());

        fireEvent.press(getByLabelText('add-topic-f1'));
        fireEvent.changeText(getByTestId('add-topic-input'), 'AI regulation');
        fireEvent.press(getByLabelText('confirm-add-topic'));

        // The WEIGHT is asserted, not incidental: a topic created at 0 is
        // dropped by buildRetrievalProfile and never queried, so a hand-added
        // topic used to render its own row and fetch nothing, forever.
        await waitFor(() =>
            expect(mockCreateTopics).toHaveBeenCalledWith([
                { factId: 'f1', text: 'AI regulation', weight: expect.any(Number) },
            ]),
        );
        const [[[input]]] = mockCreateTopics.mock.calls as [[[{ weight: number }]]];
        expect(input.weight).toBeGreaterThan(0);
    });

    it("generate-more's cloud branch routes through syncLlmTopicsForFact, converging with the on-device job handler's own call", async () => {
        mockFacts = [{ id: 'f1', statement: 'Lives in Pune' }];
        const {
            generateTopicsForFact,
        } = require('@/lib/mera-protocol/topic-generation-service') as { generateTopicsForFact: jest.Mock };
        generateTopicsForFact.mockResolvedValue(['New topic']);

        const { getByText, getByLabelText } = render(<FactsList />);
        await waitFor(() => expect(getByText('Lives in Pune')).toBeTruthy());

        fireEvent.press(getByLabelText('generate-more-f1'));
        fireEvent.press(getByLabelText('confirm-generate-more'));

        await waitFor(() =>
            expect(mockSyncLlmTopicsForFact).toHaveBeenCalledWith('f1', ['New topic']),
        );
    });
});

describe('FactsList article counts (F45, Q13)', () => {
    it('reads only renderable counts, and re-reads when the tab regains focus', async () => {
        mockFacts = [{ id: 'f1', statement: 'Lives in Pune' }];
        mockRenderableCounts.mockImplementation(() => Promise.resolve(new Map([['hiking', 3]])));
        const r = render(<FactsList />);
        await waitFor(() => expect(r.getByTestId('count-state-f1').props.children).toBe('ready:rest:3'));
        const before = mockRenderableCounts.mock.calls.length;
        mockRenderableCounts.mockImplementation(() => Promise.resolve(new Map([['hiking', 7]])));
        await act(async () => { mockFocusCallbacks[mockFocusCallbacks.length - 1](); });
        expect(mockRenderableCounts.mock.calls.length).toBeGreaterThan(before);
        await waitFor(() => expect(r.getByTestId('count-state-f1').props.children).toBe('ready:rest:7'));
    });

    it('says counting until the first read lands, then gives up after the time limit', async () => {
        jest.useFakeTimers();
        try {
            mockFacts = [{ id: 'f1', statement: 'Lives in Pune' }];
            mockRenderableCounts.mockImplementation(() => new Promise(() => {}));
            const r = render(<FactsList />);
            expect(r.getByTestId('count-state-f1').props.children).toBe('counting:rest:0');
            act(() => { jest.advanceTimersByTime(8000); });
            expect(r.getByTestId('count-state-f1').props.children).toBe('unavailable:rest:0');
        } finally {
            jest.useRealTimers();
        }
    });

    it('passes edit mode through to every row', async () => {
        mockFacts = [{ id: 'f1', statement: 'Lives in Pune' }];
        const r = render(<FactsList editing />);
        await waitFor(() => expect(r.getByTestId('count-state-f1').props.children).toMatch(/:editing:/));
    });
});
