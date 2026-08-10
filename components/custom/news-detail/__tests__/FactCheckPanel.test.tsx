// FactCheckPanel — the render half of item 14. Three properties are pinned
// here because nothing else enforces them:
//   • a result that arrives before the progress delay NEVER shows a spinner
//     (the cross-user cache hit — tap straight to verdict);
//   • the hedging disclaimer and the citation list render with EVERY verdict,
//     including 'supported';
//   • an insecure citation is shown but never opened (item 16).
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, opts?: Record<string, unknown>) =>
            opts ? `${key}::${JSON.stringify(opts)}` : key,
    }),
}));

const mockUseFactCheck = jest.fn();
jest.mock('@/lib/fact-check/use-fact-check', () => ({
    useFactCheck: (...args: unknown[]) => mockUseFactCheck(...args),
}));

// The panel is gated on the protocol store's `factCheckEnabled` (BETA,
// off by default). Mocked at module level so the real store — and its
// WatermelonDB import chain — never loads in this render-only suite, and so
// every existing case below can opt back in with a single `mockReturnValue`.
const mockUseFactCheckEnabled = jest.fn(() => true);
jest.mock('@/lib/stores/mera-protocol-store', () => ({
    useFactCheckEnabled: () => mockUseFactCheckEnabled(),
}));

const mockOpenInAppBrowser = jest.fn((..._args: unknown[]) => Promise.resolve());
jest.mock('@/lib/web-browser-utils', () => ({
    openInAppBrowser: (...args: unknown[]) => mockOpenInAppBrowser(...args),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
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
jest.mock('@/components/ui/spinner', () => {
    const { View } = require('react-native');
    return { Spinner: (p: any) => <View testID="spinner" {...p} /> };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import FactCheckPanel from '../FactCheckPanel';

const start = jest.fn();
const dismiss = jest.fn();

function hookState(overrides: Record<string, unknown> = {}) {
    mockUseFactCheck.mockReturnValue({
        phase: 'idle',
        result: null,
        showProgress: false,
        timeoutKey: null,
        start,
        dismiss,
        ...overrides,
    });
}

const completeRow = (overrides: Record<string, unknown> = {}) => ({
    _id: 'fc1',
    status: 'complete',
    verdict: 'supported',
    summary: 'Two other outlets report the same figures.',
    claims: [],
    citations: [{ title: 'Reuters report', uri: 'https://vertexaisearch.google/x', snippet: null }],
    ...overrides,
});

describe('FactCheckPanel', () => {
    beforeEach(() => jest.clearAllMocks());

    it('renders the action button when idle and starts on tap', () => {
        hookState();
        const { getByTestId, queryByTestId } = render(<FactCheckPanel articleId="a1" />);
        expect(queryByTestId('fact-check-panel')).toBeNull();
        fireEvent.press(getByTestId('fact-check-action'));
        expect(start).toHaveBeenCalledTimes(1);
    });

    it('keeps the button (no spinner, no empty card) while the wait is imperceptible', () => {
        hookState({ phase: 'working', showProgress: false });
        const { getByTestId, queryByTestId } = render(<FactCheckPanel articleId="a1" />);
        expect(getByTestId('fact-check-action')).toBeTruthy();
        expect(queryByTestId('spinner')).toBeNull();
        expect(queryByTestId('fact-check-panel')).toBeNull();
    });

    it('shows the panel and a spinner once the wait is perceptible', () => {
        hookState({ phase: 'working', showProgress: true });
        const { getByTestId, getByText } = render(<FactCheckPanel articleId="a1" />);
        expect(getByTestId('fact-check-panel')).toBeTruthy();
        expect(getByTestId('spinner')).toBeTruthy();
        expect(getByText('factCheck.checking')).toBeTruthy();
    });

    it('goes straight from the button to the verdict for a cached result', () => {
        hookState({ phase: 'ready', result: completeRow(), showProgress: false });
        const { getByTestId, queryByTestId, getByText } = render(<FactCheckPanel articleId="a1" />);
        expect(queryByTestId('fact-check-action')).toBeNull();
        expect(queryByTestId('spinner')).toBeNull();
        expect(getByTestId('fact-check-verdict')).toBeTruthy();
        expect(getByText('factCheck.verdict.supported.label')).toBeTruthy();
    });

    it('always shows the hedging disclaimer and the citations — including for "supported"', () => {
        hookState({ phase: 'ready', result: completeRow() });
        const { getByText, getByTestId } = render(<FactCheckPanel articleId="a1" />);
        expect(getByText('factCheck.disclaimer')).toBeTruthy();
        expect(getByText('factCheck.citationsHeading')).toBeTruthy();
        expect(getByTestId('fact-check-citation-0')).toBeTruthy();
    });

    it('reads an unknown verdict as the hedged generic copy, never the raw token', () => {
        hookState({ phase: 'ready', result: completeRow({ verdict: 'MOSTLY_TRUE' }) });
        const { getByText, queryByText } = render(<FactCheckPanel articleId="a1" />);
        expect(getByText('factCheck.verdict.unknown.label')).toBeTruthy();
        expect(queryByText('MOSTLY_TRUE')).toBeNull();
    });

    it('renders the per-claim breakdown', () => {
        hookState({
            phase: 'ready',
            result: completeRow({
                claims: [{ claim: 'The dam was completed in 2019.', assessment: 'disputed', note: 'Two dates cited.' }],
            }),
        });
        const { getByText } = render(<FactCheckPanel articleId="a1" />);
        expect(getByText('factCheck.claimsHeading')).toBeTruthy();
        expect(getByText('The dam was completed in 2019.')).toBeTruthy();
        expect(getByText('factCheck.assessment.disputed')).toBeTruthy();
        expect(getByText('Two dates cited.')).toBeTruthy();
    });

    it('opens a citation in the in-app browser with no UTM referrer', () => {
        hookState({ phase: 'ready', result: completeRow() });
        const { getByTestId } = render(<FactCheckPanel articleId="a1" />);
        fireEvent.press(getByTestId('fact-check-citation-0'));
        expect(mockOpenInAppBrowser).toHaveBeenCalledWith('https://vertexaisearch.google/x');
    });

    it('shows an insecure citation but never opens it (item 16)', () => {
        hookState({
            phase: 'ready',
            result: completeRow({
                citations: [{ title: 'Sketchy source', uri: 'http://plain.example.com/x', snippet: null }],
            }),
        });
        const { getByTestId, getByText } = render(<FactCheckPanel articleId="a1" />);
        expect(getByText('Sketchy source')).toBeTruthy();
        fireEvent.press(getByTestId('fact-check-citation-0'));
        expect(mockOpenInAppBrowser).not.toHaveBeenCalled();
    });

    it('warns when a check came back with no sources at all', () => {
        hookState({ phase: 'ready', result: completeRow({ citations: [] }) });
        const { getByText } = render(<FactCheckPanel articleId="a1" />);
        expect(getByText('factCheck.noCitations')).toBeTruthy();
    });

    it('renders the blocked terminal state instead of a verdict', () => {
        hookState({ phase: 'ready', result: completeRow({ status: 'blocked', verdict: null }) });
        const { getByText, queryByTestId } = render(<FactCheckPanel articleId="a1" />);
        expect(getByText('factCheck.blocked')).toBeTruthy();
        expect(queryByTestId('fact-check-verdict')).toBeNull();
    });

    it('uses the timeout key the hook resolved, and offers a retry', () => {
        hookState({ phase: 'timeout', timeoutKey: 'factCheck.failed' });
        const { getByText, getByTestId } = render(<FactCheckPanel articleId="a1" />);
        expect(getByText('factCheck.failed')).toBeTruthy();
        fireEvent.press(getByTestId('fact-check-retry'));
        expect(start).toHaveBeenCalledTimes(1);
    });

    it('offers a retry from the error state', () => {
        hookState({ phase: 'error' });
        const { getByText, getByTestId } = render(<FactCheckPanel articleId="a1" />);
        expect(getByText('factCheck.error')).toBeTruthy();
        fireEvent.press(getByTestId('fact-check-retry'));
        expect(start).toHaveBeenCalledTimes(1);
    });

    it('hide collapses the panel via the hook', () => {
        hookState({ phase: 'ready', result: completeRow() });
        const { getByTestId } = render(<FactCheckPanel articleId="a1" />);
        fireEvent.press(getByTestId('fact-check-hide'));
        expect(dismiss).toHaveBeenCalledTimes(1);
    });

    // BETA gate — off by default (mera-protocol-store.ts). The button, the
    // panel, and any verdict must all disappear regardless of the hook's
    // phase; nothing renders while the setting is off.
    it('renders nothing when fact check is disabled, even mid-check or with a ready verdict', () => {
        mockUseFactCheckEnabled.mockReturnValue(false);
        try {
            hookState({ phase: 'ready', result: completeRow() });
            const { toJSON, queryByTestId } = render(<FactCheckPanel articleId="a1" />);
            expect(toJSON()).toBeNull();
            expect(queryByTestId('fact-check-action')).toBeNull();
            expect(queryByTestId('fact-check-panel')).toBeNull();
        } finally {
            mockUseFactCheckEnabled.mockReturnValue(true);
        }
    });
});
