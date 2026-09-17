/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
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
});

describe('FactAccordion — pending/done/error, driven by the interim status heuristic', () => {
    // Today's status is still derived from metadata (topicGenError / topics
    // length) — the interim shape pending on P3's DTO commit (see the
    // component's own comment). These fixtures pin the CURRENT source; only
    // the `status` assignment line changes once `fact.topicsStatus` lands,
    // not any of the assertions below.

    it('pending: no topics, no error — header spinner, generating caption, no topic list, no retry', () => {
        const fact = baseFact({ metadata: {} });
        const { getByTestId, getByText, queryByTestId, queryByText } = render(
            <FactAccordion {...baseProps} fact={fact} />,
        );
        expect(getByTestId('fact-topics-pending-f1')).toBeTruthy();
        expect(getByTestId('fact-topics-pending-f1-spinner')).toBeTruthy();
        expect(getByText('configPanel.generatingTopics')).toBeTruthy();
        expect(queryByTestId('fact-topics-retry-f1')).toBeNull();
        expect(queryByText('Mountain trail running')).toBeNull();
    });

    // Held, not deleted: zero topics is only honestly distinguishable as
    // 'done' vs 'pending' once `fact.topicsStatus` is real (P3's DTO commit,
    // still gated). The interim heuristic below re-derives status from
    // `expectedTopicCount > 0`, so a fact with zero topics reads as 'pending'
    // no matter WHY it has zero — exactly the gap the real field closes. This
    // un-skips the moment the `status` assignment swaps to `fact.topicsStatus
    // ?? 'done'`, with no other change to the test.
    it.skip('done: zero topics is valid — no spinner, no error, no retry, just the add/generate affordances', () => {
        const fact = baseFact({ metadata: { topics: [] } });
        const { queryByTestId, getByText, queryByText } = render(
            <FactAccordion {...baseProps} fact={fact} />,
        );
        expect(queryByTestId('fact-topics-pending-f1')).toBeNull();
        expect(queryByTestId('fact-topics-retry-f1')).toBeNull();
        expect(queryByText('configPanel.generatingTopics')).toBeNull();
        expect(getByText('configPanel.addTopic')).toBeTruthy();
    });

    it('done: topics present — list renders, article-count pill shows when totalCount > 0', () => {
        const fact = baseFact({ metadata: { topics: ['Mountain trail running'] } });
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

    it('error: generic copy renders, never the raw metadata.topicGenError string', () => {
        const fact = baseFact({
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
        const fact = baseFact({ metadata: { topicGenError: ['boom'] } });
        const { getByTestId } = render(<FactAccordion {...baseProps} fact={fact} />);
        fireEvent.press(getByTestId('fact-topics-retry-f1'));
        expect(mockRetryTopicGeneration).toHaveBeenCalledTimes(1);
        expect(mockRetryTopicGeneration).toHaveBeenCalledWith('f1', 'Loves hiking in the mountains');
    });

    it('error: busy-follows-status — pressing retry disables the control, and it clears when the fact re-renders as pending (never in a `finally`)', () => {
        const errorFact = baseFact({ metadata: { topicGenError: ['boom'] } });
        const { getByTestId, rerender, queryByTestId } = render(
            <FactAccordion {...baseProps} fact={errorFact} />,
        );
        fireEvent.press(getByTestId('fact-topics-retry-f1'));
        expect(getByTestId('fact-topics-retry-f1').props.accessibilityState.disabled).toBe(true);

        // Simulate the live status leaving 'error' (what `fact.topicsStatus`
        // flipping to 'pending' will do once P3's DTO field lands) — here,
        // driven by the interim heuristic, that's a fact with no error and no
        // topics yet.
        const pendingFact = baseFact({ metadata: {} });
        rerender(<FactAccordion {...baseProps} fact={pendingFact} />);
        expect(queryByTestId('fact-topics-retry-f1')).toBeNull();
        expect(getByTestId('fact-topics-pending-f1')).toBeTruthy();
    });
});
