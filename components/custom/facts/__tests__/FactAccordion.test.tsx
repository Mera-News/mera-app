/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim — same as FactsList.test.tsx.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

// StatusIndicator's own ActivityIndicator/text/icon mock recipe
// (components/custom/chat/__tests__/StatusIndicator.test.tsx) — this suite
// renders the REAL StatusIndicator (not a stub), so it needs the same three.
jest.mock('react-native/Libraries/Components/ActivityIndicator/ActivityIndicator', () => {
    const R = require('react');
    const RN = require('react-native');
    return { __esModule: true, default: (p: any) => R.createElement(RN.View, p) };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
// Icon rendered as a View keyed by its glyph name — vector-icons does not
// forward testID under this mock, so assertions match on `icon-${name}`.
jest.mock('@expo/vector-icons', () => {
    const R = require('react');
    const RN = require('react-native');
    return {
        MaterialIcons: (p: any) => R.createElement(RN.View, { ...p, testID: `icon-${p.name}` }),
    };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string, opts?: any) => (opts?.defaultValue ?? key) }),
}));

jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return { __esModule: true, GlassPanel: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: ({ text, ...p }: any) => <Text {...p}>{text}</Text> };
});
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: (p: any) => <Pressable {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
    };
});
jest.mock('@/components/ui/spinner', () => {
    const { View } = require('react-native');
    return { Spinner: (p: any) => <View {...p} /> };
});

const mockNudgeFactWeight = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/database/services/mutation-rails-service', () => ({
    nudgeFactWeight: (...a: unknown[]) => mockNudgeFactWeight(...a),
}));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn() } }));
jest.mock('@/lib/stores/for-you-store', () => ({
    useForYouStore: { getState: () => ({ setFeedNeedsRefresh: jest.fn() }) },
}));

const mockRetryTopicGeneration = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/chat-tools/tool-handlers', () => ({
    retryTopicGeneration: (...a: unknown[]) => mockRetryTopicGeneration(...a),
}));

// observeByFact's rows for the CURRENT fixture, settable per test, with a
// way to push a SECOND emission (`emitTopicRows`) to simulate a delete
// committed from somewhere else entirely — chat's chip, in production.
// Importing the real module constructs WatermelonDB's SQLite adapter at
// import time, which has no native module under Jest — same class of
// problem P3's own plan flags for suites reaching lib/database/index
// transitively.
type TopicRowFixture = { id: string; text: string; status: string };
let mockTopicRows: TopicRowFixture[] = [];
let mockTopicSubscribers: ((rows: TopicRowFixture[]) => void)[] = [];
function emitTopicRows(rows: TopicRowFixture[]) {
    mockTopicRows = rows;
    for (const cb of mockTopicSubscribers) cb(rows);
}
jest.mock('@/lib/database/services/topic-service', () => ({
    observeByFact: () => ({
        subscribe: (cb: (rows: TopicRowFixture[]) => void) => {
            mockTopicSubscribers.push(cb);
            cb(mockTopicRows);
            return {
                unsubscribe: () => {
                    mockTopicSubscribers = mockTopicSubscribers.filter((s) => s !== cb);
                },
            };
        },
    }),
}));

import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import FactAccordion from '../FactAccordion';

const baseFact = (overrides: Partial<Fact> = {}): Fact => ({
    id: 'f1',
    statement: 'Loves hiking in the mountains',
    weight: null,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
});

const baseProps = {
    isExpanded: true,
    articleCountByTopic: new Map<string, number>(),
    isGeneratingMore: false,
    onToggle: jest.fn(),
    onDeletePress: jest.fn(),
    onFactArticles: jest.fn(),
    onTopicPress: jest.fn(),
    onDeleteTopic: jest.fn(),
    onAddTopic: jest.fn(),
    onGenerateMore: jest.fn(),
};

beforeEach(() => {
    jest.clearAllMocks();
    mockTopicRows = [];
    mockTopicSubscribers = [];
});

describe('FactAccordion — pending/done/error, driven by fact.topicsStatus (P3\'s DTO field)', () => {
    it('pending: header spinner, generating caption, no topic list, no retry', () => {
        const fact = baseFact({ topicsStatus: 'pending' });
        const { getByTestId, getByText, queryByTestId, queryByText } = render(
            <FactAccordion {...baseProps} fact={fact} />,
        );
        expect(getByTestId('fact-topics-pending-f1')).toBeTruthy();
        expect(getByTestId('fact-topics-pending-f1-spinner')).toBeTruthy();
        expect(getByText('configPanel.generatingTopics')).toBeTruthy();
        expect(queryByTestId('fact-topics-retry-f1')).toBeNull();
        expect(queryByText('Mountain trail running')).toBeNull();
    });

    it('done: zero topics is a valid done state — no spinner, no error, no retry, just the add/generate affordances', () => {
        // The case the interim heuristic could never honestly pass: zero
        // topic rows because generation is still running vs. zero because
        // it finished and every topic was since deleted are indistinguishable
        // without this field. mockTopicRows stays empty (default).
        const fact = baseFact({ topicsStatus: 'done' });
        const { queryByTestId, getByText, queryByText } = render(
            <FactAccordion {...baseProps} fact={fact} />,
        );
        expect(queryByTestId('fact-topics-pending-f1')).toBeNull();
        expect(queryByTestId('fact-topics-retry-f1')).toBeNull();
        expect(queryByText('configPanel.generatingTopics')).toBeNull();
        expect(getByText('configPanel.addTopic')).toBeTruthy();
    });

    it('done: topics present — list renders (from observeByFact), article-count pill shows when totalCount > 0', () => {
        mockTopicRows = [{ id: 't1', text: 'Mountain trail running', status: 'active' }];
        const fact = baseFact({ topicsStatus: 'done' });
        const counts = new Map([['Mountain trail running', 3]]);
        const { getByText, getAllByText, queryByTestId } = render(
            <FactAccordion {...baseProps} fact={fact} articleCountByTopic={counts} />,
        );
        expect(getByText('Mountain trail running')).toBeTruthy();
        // Two matches: the header pill AND the per-topic row count, both
        // resolving to the same mocked key.
        expect(getAllByText('configPanel.articleCount').length).toBeGreaterThan(0);
        expect(queryByTestId('fact-topics-pending-f1')).toBeNull();
    });

    it('a NULL/undefined topicsStatus on a live fact renders exactly like done, never pending — P3\'s migration-residue rule', () => {
        const fact = baseFact({ topicsStatus: undefined });
        const { queryByTestId, queryByText, getByText } = render(
            <FactAccordion {...baseProps} fact={fact} />,
        );
        expect(queryByTestId('fact-topics-pending-f1')).toBeNull();
        expect(queryByTestId('fact-topics-retry-f1')).toBeNull();
        expect(queryByText('configPanel.generatingTopics')).toBeNull();
        expect(getByText('configPanel.addTopic')).toBeTruthy();
    });

    it('error: generic copy renders, never the raw metadata.topicGenError string', () => {
        const fact = baseFact({
            topicsStatus: 'error',
            metadata: { topicGenError: ['ECONNRESET: upstream timeout at 10.0.0.4:8080'] },
        });
        const { getByText, queryByText, getByTestId } = render(
            <FactAccordion {...baseProps} fact={fact} />,
        );
        expect(getByText('configPanel.topicGenFailedGeneric')).toBeTruthy();
        expect(queryByText(/ECONNRESET/)).toBeNull();
        expect(queryByText(/10\.0\.0\.4/)).toBeNull();
        expect(getByTestId('fact-topics-retry-f1')).toBeTruthy();
        expect(getByTestId('fact-topics-retry-body-button-f1')).toBeTruthy();
    });

    it('error: pressing the header retry calls retryTopicGeneration exactly once with id + statement', () => {
        const fact = baseFact({ topicsStatus: 'error', metadata: { topicGenError: ['boom'] } });
        const { getByTestId } = render(<FactAccordion {...baseProps} fact={fact} />);
        fireEvent.press(getByTestId('fact-topics-retry-f1'));
        expect(mockRetryTopicGeneration).toHaveBeenCalledTimes(1);
        expect(mockRetryTopicGeneration).toHaveBeenCalledWith('f1', 'Loves hiking in the mountains');
    });

    it('error: busy-follows-status — pressing retry disables the control, and it clears when the fact re-renders with a different status (never in a `finally`)', () => {
        const errorFact = baseFact({ topicsStatus: 'error', metadata: { topicGenError: ['boom'] } });
        const { getByTestId, rerender, queryByTestId } = render(
            <FactAccordion {...baseProps} fact={errorFact} />,
        );
        fireEvent.press(getByTestId('fact-topics-retry-f1'));
        expect(getByTestId('fact-topics-retry-f1').props.accessibilityState.disabled).toBe(true);

        // The live status leaving 'error' — what `fact.topicsStatus` flipping
        // to 'pending' looks like once beginTopicGeneration stamps it.
        const pendingFact = baseFact({ topicsStatus: 'pending' });
        rerender(<FactAccordion {...baseProps} fact={pendingFact} />);
        expect(queryByTestId('fact-topics-retry-f1')).toBeNull();
        expect(getByTestId('fact-topics-pending-f1')).toBeTruthy();
    });
});

describe('FactAccordion — B3: topic list reads observeByFact, not fact.metadata.topics', () => {
    it('a topic deleted from ANOTHER surface (chat) disappears here too, with nothing pressed on this screen', () => {
        // The actual cross-surface-consistency regression test: a delete via
        // THIS screen's own handler would pass even on the old
        // metadata-based render, because the handler and the render agreed
        // with each other while both disagreed with chat. This asserts the
        // read side alone reacts to a row vanishing out from under it.
        mockTopicRows = [
            { id: 't1', text: 'Mountain trail running', status: 'active' },
            { id: 't2', text: 'Alpine gear reviews', status: 'active' },
        ];
        const fact = baseFact({ metadata: { topics: ['Mountain trail running', 'Alpine gear reviews'] } });
        const { getByText, queryByText } = render(<FactAccordion {...baseProps} fact={fact} />);
        expect(getByText('Mountain trail running')).toBeTruthy();
        expect(getByText('Alpine gear reviews')).toBeTruthy();

        act(() => {
            emitTopicRows([{ id: 't1', text: 'Mountain trail running', status: 'active' }]);
        });

        expect(getByText('Mountain trail running')).toBeTruthy();
        expect(queryByText('Alpine gear reviews')).toBeNull();
    });

    it('a "retired" row (persona-change-log revert, not a staged delete) is not shown — no undo chip exists here', () => {
        mockTopicRows = [
            { id: 't1', text: 'Mountain trail running', status: 'active' },
            { id: 't2', text: 'Old topic', status: 'retired' },
        ];
        const fact = baseFact({ metadata: { topics: ['Mountain trail running'] } });
        const { getByText, queryByText } = render(<FactAccordion {...baseProps} fact={fact} />);
        expect(getByText('Mountain trail running')).toBeTruthy();
        expect(queryByText('Old topic')).toBeNull();
    });

    it('pressing a topic\'s delete icon calls onDeleteTopic with the fact and the ROW ({id, text}), not a bare string', () => {
        mockTopicRows = [{ id: 't1', text: 'Mountain trail running', status: 'active' }];
        const fact = baseFact({ metadata: { topics: ['Mountain trail running'] } });
        const onDeleteTopic = jest.fn();
        const { getByTestId } = render(
            <FactAccordion {...baseProps} fact={fact} onDeleteTopic={onDeleteTopic} />,
        );
        fireEvent.press(getByTestId('topic-delete-t1'));
        expect(onDeleteTopic).toHaveBeenCalledTimes(1);
        expect(onDeleteTopic).toHaveBeenCalledWith(fact, { id: 't1', text: 'Mountain trail running' });
    });

    it('round-2 item (10): the removal-consequence line shows only when there is at least one topic to warn about', () => {
        // topicsStatus is 'done' throughout — activeTopics (observeByFact),
        // not topicsStatus, is what the consequence line's own condition
        // checks, and this pins that the two are independent.
        mockTopicRows = [];
        const fact = baseFact({ topicsStatus: 'done' });
        const { queryByText } = render(<FactAccordion {...baseProps} fact={fact} />);
        expect(queryByText('facts.topicRemovalConsequence')).toBeNull();

        act(() => {
            emitTopicRows([{ id: 't1', text: 'Mountain trail running', status: 'active' }]);
        });
        expect(queryByText('facts.topicRemovalConsequence')).toBeTruthy();
    });
});
