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

// For the "real observeFacts, not a hand-built DTO" reproduction only —
// fact-service imports the real database singleton, which constructs a real
// SQLite adapter under Jest. Everywhere else in this file `Fact` objects are
// hand-built and never touch this.
jest.mock('@/lib/database/index', () => {
    const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
    return makeDatabaseMock();
});

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

// B7: the first ReanimatedSwipeable in the repo, no house mock exists yet.
// Renders renderLeftActions' output ahead of children (so the trash is
// queryable/pressable), forwards `enabled` onto the host node (so a test can
// read it back), and exposes a `-trigger-open` Pressable that stands in for
// a real swipe gesture, which jest cannot simulate — pressing it fires
// onSwipeableWillOpen exactly as a real swipe-open would. The ref resolves
// to a fresh `{ close, openLeft, openRight, reset }` jest.fn() bag per
// mounted instance, not shared module state, so two rows in the same test
// don't observe each other's calls.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
    const R = require('react');
    const { View, Pressable } = require('react-native');
    const MockSwipeable = R.forwardRef((props: any, ref: any) => {
        const methods = R.useRef({ close: jest.fn(), openLeft: jest.fn(), openRight: jest.fn(), reset: jest.fn() });
        R.useImperativeHandle(ref, () => methods.current);
        const left = props.renderLeftActions
            ? props.renderLeftActions({ value: 0 }, { value: 0 }, methods.current)
            : null;
        return (
            <View testID={props.testID} enabled={props.enabled}>
                {left}
                <Pressable
                    testID={`${props.testID}-trigger-open`}
                    onPress={() => props.onSwipeableWillOpen?.('left')}
                />
                {props.children}
            </View>
        );
    });
    return { __esModule: true, default: MockSwipeable };
});

const mockNudgeFactWeight = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/database/services/mutation-rails-service', () => ({
    nudgeFactWeight: (...a: unknown[]) => mockNudgeFactWeight(...a),
}));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn() } }));

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

describe('FactAccordion — the statement always renders, in every state', () => {
    // Coordinator/user feedback: the pending state must never replace the
    // fact phrase, collapsed or expanded — a secondary caption is added
    // BESIDE it, never instead of it.
    it.each(['pending', 'done', 'error'] as const)(
        'renders the fact statement when topicsStatus is %s, collapsed',
        (topicsStatus) => {
            const fact = baseFact({
                topicsStatus,
                metadata: topicsStatus === 'error' ? { topicGenError: ['boom'] } : {},
            });
            const { getByText } = render(
                <FactAccordion {...baseProps} fact={fact} isExpanded={false} />,
            );
            expect(getByText('Loves hiking in the mountains')).toBeTruthy();
        },
    );

    it.each(['pending', 'done', 'error'] as const)(
        'renders the fact statement when topicsStatus is %s, expanded',
        (topicsStatus) => {
            const fact = baseFact({
                topicsStatus,
                metadata: topicsStatus === 'error' ? { topicGenError: ['boom'] } : {},
            });
            const { getByText } = render(
                <FactAccordion {...baseProps} fact={fact} isExpanded={true} />,
            );
            expect(getByText('Loves hiking in the mountains')).toBeTruthy();
        },
    );

    it('the pending caption sits ALONGSIDE the statement, collapsed — not gated on being expanded', () => {
        const fact = baseFact({ topicsStatus: 'pending' });
        const { getByText } = render(
            <FactAccordion {...baseProps} fact={fact} isExpanded={false} />,
        );
        expect(getByText('Loves hiking in the mountains')).toBeTruthy();
        expect(getByText('configPanel.generatingTopics')).toBeTruthy();
    });

    it('the error consequence line sits ALONGSIDE the statement, collapsed — not gated on being expanded', () => {
        const fact = baseFact({ topicsStatus: 'error', metadata: { topicGenError: ['boom'] } });
        const { getByText } = render(
            <FactAccordion {...baseProps} fact={fact} isExpanded={false} />,
        );
        expect(getByText('Loves hiking in the mountains')).toBeTruthy();
        expect(getByText('configPanel.topicGenFailedGeneric')).toBeTruthy();
    });

    // Device check at d1196cd: a real pending fact (Rotterdam residence)
    // rendered blank. Every other test in this file hand-builds its `Fact`
    // fixture, which trivially always carries `.statement` — that can never
    // catch a real mapping bug between the WatermelonDB record and the DTO.
    // This one runs the REAL `toFact()` (via the real, exported
    // `observeFacts()`, unmocked) against a fake WatermelonDB row, closing
    // that blind spot.
    it('a REAL pending fact, mapped through the real observeFacts()/toFact() (not a hand-built DTO), still renders its statement', async () => {
        const database = require('@/lib/database/index').default;
        const { makeRecord } = require('@/lib/__test-helpers__/mockDatabase');
        const { of } = require('rxjs');

        const record = makeRecord({
            id: 'f-rotterdam',
            statement: 'Lives in Rotterdam',
            metadata: undefined,
            weight: null,
            questionnaireLevel: undefined,
            questionnaireLevelCategory: undefined,
            questionnaireAttribute: undefined,
            topicsStatus: 'pending',
            topicsUpdatedAt: null,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
        });
        const col = database.get('facts');
        col.query = jest.fn(() => ({ observeWithColumns: () => of([record]) }));

        const { observeFacts } = require('@/lib/database/services/fact-service');
        const realFacts: any[] = await new Promise((resolve) => {
            observeFacts().subscribe((facts: any[]) => resolve(facts));
        });

        expect(realFacts).toHaveLength(1);
        const realFact = realFacts[0];
        // The mapping itself, asserted directly — if this fails, the bug is
        // in toFact()/observeFacts(), not in FactAccordion.
        expect(realFact.statement).toBe('Lives in Rotterdam');
        expect(realFact.topicsStatus).toBe('pending');

        const { getByText, getByTestId } = render(
            <FactAccordion {...baseProps} fact={realFact} isExpanded={false} />,
        );
        expect(getByText('Lives in Rotterdam')).toBeTruthy();
        expect(getByTestId('fact-topics-pending-f-rotterdam')).toBeTruthy();
    });
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
        // The owner's complaint was "just the spinner is visible" — the
        // statement itself is unconditional in the JSX, but assert it here
        // too so this exact regression (statement hidden while pending) has
        // a test tied to the same fixture the complaint was about.
        expect(getByText('Loves hiking in the mountains')).toBeTruthy();
    });

    it('pending: the spinner slot is labelled "Finding topics" and sized like the done badge, so the row does not jump', () => {
        const pendingFact = baseFact({ topicsStatus: 'pending' });
        const pending = render(<FactAccordion {...baseProps} fact={pendingFact} />);
        // Base testID (`fact-topics-pending-f1`) and its `-spinner` child
        // are unchanged — they're StatusIndicator's own, asserted in the
        // test above. The new a11y wrapper around it carries `-slot`.
        const pendingSlot = pending.getByTestId('fact-topics-pending-f1-slot');
        expect(pendingSlot.props.accessibilityLabel).toBe('Finding topics');
        expect(pending.getByTestId('fact-topics-pending-f1')).toBeTruthy();
        expect(pending.getByTestId('fact-topics-pending-f1-spinner')).toBeTruthy();

        mockTopicRows = [{ id: 't1', text: 'trail running', status: 'active' }];
        const doneFact = baseFact({ topicsStatus: 'done' });
        const done = render(
            <FactAccordion
                {...baseProps}
                fact={doneFact}
                articleCountByTopic={new Map([['trail running', 5]])}
            />,
        );
        const badge = done.getAllByText('configPanel.articleCount')[0];

        // Both slots sit in the SAME trailing HStack, which carries the
        // shared minHeight — read it off the row ancestor they share rather
        // than the leaf, since the leaf nodes are different element types
        // (a View with a spinner vs a pill Button) with no comparable size
        // of their own.
        const pendingRow = pending.UNSAFE_root.findAll(
            (n: any) => typeof n.props?.style?.minHeight === 'number',
        )[0];
        const doneRow = done.UNSAFE_root.findAll(
            (n: any) => typeof n.props?.style?.minHeight === 'number',
        )[0];
        expect(pendingRow.props.style.minHeight).toBeGreaterThan(0);
        expect(pendingRow.props.style.minHeight).toBe(doneRow.props.style.minHeight);
        expect(badge).toBeTruthy();
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

describe('F14: fact and topic text keep their own casing', () => {
    // iOS `capitalize` is NSString capitalizedString, which lowercases the rest
    // of every word: "AI" became "Ai", "(DMA)" became "(Dma)".
    it('sentence-cases the statement and topics without a capitalize transform', () => {
        mockTopicRows = [{ id: 't1', text: 'EU digital markets act (DMA)', status: 'active' }];
        const r = render(
            <FactAccordion {...baseProps} fact={baseFact({ statement: 'interested in privacy-preserving AI' })} />,
        );
        const statement = r.getByText('Interested in privacy-preserving AI');
        expect(String(statement.props.className ?? '')).not.toMatch(/capitalize/);
        const topic = r.getByText('EU digital markets act (DMA)');
        expect(String(topic.props.className ?? '')).not.toMatch(/capitalize/);
    });
});

describe('F46: delete lives in edit mode', () => {
    it('shows no delete control at rest', () => {
        const r = render(<FactAccordion {...baseProps} isExpanded={false} fact={baseFact()} />);
        expect(r.queryByTestId('fact-delete-f1')).toBeNull();
    });

    it('in edit mode shows a labelled delete control, and never expands', () => {
        const onDeletePress = jest.fn();
        mockTopicRows = [{ id: 't1', text: 'trail running', status: 'active' }];
        const r = render(
            <FactAccordion {...baseProps} isExpanded editing onDeletePress={onDeletePress} fact={baseFact()} />,
        );
        const del = r.getByTestId('fact-delete-f1');
        expect(del.props.accessibilityLabel).toBe('facts.deleteFactA11y');
        fireEvent.press(del);
        expect(onDeletePress).toHaveBeenCalledTimes(1);
        // Expansion is off while editing: the topic list is not rendered.
        expect(r.queryByText('Trail running')).toBeNull();
    });

    it('offers Delete as a VoiceOver custom action on every row', () => {
        const onDeletePress = jest.fn();
        const r = render(<FactAccordion {...baseProps} isExpanded={false} onDeletePress={onDeletePress} fact={baseFact()} />);
        const row = r.UNSAFE_root.findAll(
            (n: any) => Array.isArray(n.props?.accessibilityActions) && typeof n.props?.onAccessibilityAction === 'function',
        )[0];
        expect(row.props.accessibilityActions).toEqual([{ name: 'delete', label: 'common.delete' }]);
        act(() => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'delete' } }));
        expect(onDeletePress).toHaveBeenCalledTimes(1);
    });
});

describe('B7: swipe right to reveal a delete icon', () => {
    it('the swipe-revealed trash is labelled and calls onDeletePress, same as edit mode', () => {
        const onDeletePress = jest.fn();
        const fact = baseFact();
        const r = render(<FactAccordion {...baseProps} isExpanded={false} onDeletePress={onDeletePress} fact={fact} />);
        const trash = r.getByTestId('fact-swipe-delete-f1');
        expect(trash.props.accessibilityLabel).toBe('facts.deleteFactA11y');
        expect(trash.props.accessibilityRole).toBe('button');
        fireEvent.press(trash);
        expect(onDeletePress).toHaveBeenCalledTimes(1);
        expect(onDeletePress).toHaveBeenCalledWith(fact);
    });

    it('the trash target is at least 44pt', () => {
        const r = render(<FactAccordion {...baseProps} isExpanded={false} fact={baseFact()} />);
        const style = r.getByTestId('fact-swipe-delete-f1').props.style;
        const flat = Array.isArray(style) ? Object.assign({}, ...style) : style;
        expect(flat.minHeight).toBeGreaterThanOrEqual(44);
        expect(flat.width).toBeGreaterThanOrEqual(44);
    });

    it('the swipe is disabled while editing — edit mode already has its own delete control', () => {
        const r = render(<FactAccordion {...baseProps} isExpanded editing fact={baseFact()} />);
        expect(r.getByTestId('fact-swipeable-f1').props.enabled).toBe(false);
    });

    it('the swipe is enabled at rest (not editing)', () => {
        const r = render(<FactAccordion {...baseProps} isExpanded={false} fact={baseFact()} />);
        expect(r.getByTestId('fact-swipeable-f1').props.enabled).toBe(true);
    });

    it('opening the swipe reports the fact id so a list can close every other open row', () => {
        const onSwipeOpen = jest.fn();
        const r = render(
            <FactAccordion {...baseProps} isExpanded={false} onSwipeOpen={onSwipeOpen} fact={baseFact()} />,
        );
        fireEvent.press(r.getByTestId('fact-swipeable-f1-trigger-open'));
        expect(onSwipeOpen).toHaveBeenCalledWith('f1');
    });

    it('hands the list a close()-able ref, and releases it on unmount', () => {
        const swipeableRef = jest.fn();
        const r = render(
            <FactAccordion {...baseProps} isExpanded={false} swipeableRef={swipeableRef} fact={baseFact()} />,
        );
        expect(swipeableRef).toHaveBeenCalledWith('f1', expect.objectContaining({ close: expect.any(Function) }));
        r.unmount();
        expect(swipeableRef).toHaveBeenLastCalledWith('f1', null);
    });
});

describe('M24 / F45: the count pill always says something true', () => {
    it('says "No articles yet" for a finished fact with nothing that can appear', () => {
        const r = render(<FactAccordion {...baseProps} isExpanded={false} fact={baseFact({ topicsStatus: 'done' } as any)} />);
        expect(r.getByTestId('fact-count-none-f1')).toBeTruthy();
    });

    it('says "Counting" before the counts land, never a false 0', () => {
        const r = render(
            <FactAccordion {...baseProps} isExpanded={false} countState="counting" fact={baseFact({ topicsStatus: 'done' } as any)} />,
        );
        expect(r.getByTestId('fact-count-pending-f1')).toBeTruthy();
        expect(r.queryByTestId('fact-count-none-f1')).toBeNull();
    });

    it('shows nothing once counting has given up', () => {
        const r = render(
            <FactAccordion {...baseProps} isExpanded={false} countState="unavailable" fact={baseFact({ topicsStatus: 'done' } as any)} />,
        );
        expect(r.queryByTestId('fact-count-pending-f1')).toBeNull();
        expect(r.queryByTestId('fact-count-none-f1')).toBeNull();
    });
});

it('the edit-mode delete control is at least 44pt', () => {
    const r = render(<FactAccordion {...baseProps} isExpanded={false} editing fact={baseFact()} />);
    const del = r.getByTestId('fact-delete-f1');
    const style = Array.isArray(del.props.style) ? Object.assign({}, ...del.props.style) : del.props.style;
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
});
