// FactCheckPanel — a PURE OBSERVER post-pivot. No action button, no retry, no
// hide: the tick (`startFactCheckChat`) is the only way in, and this component
// only ever renders what `useFactCheck` reads back off the device. Properties
// pinned here because nothing else enforces them:
//   • absent renders nothing at all;
//   • a processing row below the progress delay renders nothing (no flash);
//   • the hedging disclaimer and the citation list render with EVERY verdict;
//   • an insecure citation is shown but never opened;
//   • several terminal rows STACK — one card per claim.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, opts?: Record<string, unknown>) =>
            opts ? `${key}::${JSON.stringify(opts)}` : key,
    }),
}));

const mockUseFactCheck = jest.fn();
jest.mock('@/lib/fact-check/use-fact-check', () => ({
    useFactCheck: (...a: unknown[]) => mockUseFactCheck(...a),
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

function hookState(overrides: Record<string, unknown> = {}) {
    mockUseFactCheck.mockReturnValue({
        phase: 'absent',
        showProgress: false,
        rows: [],
        ...overrides,
    });
}

const renderPanel = () => render(<FactCheckPanel articleId="a1" />);

const storedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'row-0',
    articleId: 'a1',
    factCheckId: 'fc1',
    articleTitle: 'A headline',
    status: 'complete',
    verdict: 'supported',
    claim: 'The dam was completed in 2019.',
    claimKey: 'k1',
    requestedAt: 1,
    resolvedAt: 2,
    payload: {
        _id: 'fc1',
        status: 'complete',
        verdict: 'supported',
        summary: 'Two other outlets report the same figures.',
        claims: [],
        citations: [{ title: 'Reuters report', uri: 'https://vertexaisearch.google/x', snippet: null }],
        checkedBy: [],
    },
    ...overrides,
});

describe('FactCheckPanel', () => {
    beforeEach(() => jest.clearAllMocks());

    it('renders nothing when absent', () => {
        hookState({ phase: 'absent', rows: [] });
        const { toJSON } = renderPanel();
        expect(toJSON()).toBeNull();
    });

    it('renders nothing while processing but below the progress delay — no flash', () => {
        hookState({ phase: 'processing', showProgress: false, rows: [storedRow({ status: 'processing' })] });
        const { toJSON, queryByTestId } = renderPanel();
        expect(toJSON()).toBeNull();
        expect(queryByTestId('spinner')).toBeNull();
    });

    it('shows the working state once the wait is perceptible', () => {
        hookState({ phase: 'processing', showProgress: true, rows: [storedRow({ status: 'processing', payload: null })] });
        const { getByTestId, getByText } = renderPanel();
        expect(getByTestId('fact-check-panel')).toBeTruthy();
        expect(getByTestId('fact-check-working')).toBeTruthy();
        expect(getByTestId('spinner')).toBeTruthy();
        expect(getByText('factCheck.checking')).toBeTruthy();
        expect(getByText('factCheck.queued')).toBeTruthy();
        expect(getByText('factCheck.queuedHint')).toBeTruthy();
    });

    it('renders the terminal verdict for a cached result, no action button anywhere', () => {
        hookState({ phase: 'terminal', rows: [storedRow()] });
        const { getByTestId, queryByTestId, getByText } = renderPanel();
        expect(getByTestId('fact-check-panel')).toBeTruthy();
        expect(queryByTestId('spinner')).toBeNull();
        expect(getByTestId('fact-check-0-verdict')).toBeTruthy();
        expect(getByText('factCheck.verdict.supported.label')).toBeTruthy();
        // The retired full-width action button is gone for good — there is
        // exactly one way in now, the action-row tick.
        expect(queryByTestId('fact-check-action')).toBeNull();
    });

    it('always shows the hedging disclaimer and the citations — including for "supported"', () => {
        hookState({ phase: 'terminal', rows: [storedRow()] });
        const { getByText, getByTestId } = renderPanel();
        expect(getByText('factCheck.disclaimer')).toBeTruthy();
        expect(getByText('factCheck.citationsHeading')).toBeTruthy();
        expect(getByTestId('fact-check-0-citation-0')).toBeTruthy();
    });

    it('reads an unknown verdict as the hedged generic copy, never the raw token', () => {
        hookState({ phase: 'terminal', rows: [storedRow({ verdict: 'MOSTLY_TRUE' })] });
        const { getByText, queryByText } = renderPanel();
        expect(getByText('factCheck.verdict.unknown.label')).toBeTruthy();
        expect(queryByText('MOSTLY_TRUE')).toBeNull();
    });

    it('renders the per-claim breakdown', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({
                payload: {
                    ...storedRow().payload,
                    claims: [{ claim: 'The dam was completed in 2019.', assessment: 'disputed', note: 'Two dates cited.' }],
                },
            })],
        });
        const { getByText } = renderPanel();
        expect(getByText('factCheck.claimsHeading')).toBeTruthy();
        expect(getByText('factCheck.assessment.disputed')).toBeTruthy();
        expect(getByText('Two dates cited.')).toBeTruthy();
    });

    it('opens a citation in the in-app browser with no UTM referrer', () => {
        hookState({ phase: 'terminal', rows: [storedRow()] });
        const { getByTestId } = renderPanel();
        fireEvent.press(getByTestId('fact-check-0-citation-0'));
        expect(mockOpenInAppBrowser).toHaveBeenCalledWith('https://vertexaisearch.google/x');
    });

    it('shows an insecure citation but never opens it', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({
                payload: {
                    ...storedRow().payload,
                    citations: [{ title: 'Sketchy source', uri: 'http://plain.example.com/x', snippet: null }],
                },
            })],
        });
        const { getByTestId, getByText } = renderPanel();
        expect(getByText('Sketchy source')).toBeTruthy();
        fireEvent.press(getByTestId('fact-check-0-citation-0'));
        expect(mockOpenInAppBrowser).not.toHaveBeenCalled();
    });

    it('lists every organisation that fact-checked the story, with its own verdict and link', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({
                payload: {
                    ...storedRow().payload,
                    checkedBy: [
                        { organisation: 'Full Fact', url: 'https://fullfact.org/a', verdict: 'disputed', summary: 'The figure was misquoted.' },
                        { organisation: 'AFP Fact Check', url: 'https://factcheck.afp.com/b', verdict: 'supported', summary: null },
                    ],
                },
            })],
        });
        const { getByText, getByTestId } = renderPanel();
        expect(getByText('factCheck.checkedByHeading')).toBeTruthy();
        expect(getByText('Full Fact')).toBeTruthy();
        expect(getByText('AFP Fact Check')).toBeTruthy();

        // Each row carries its OWN link — testIDs renamed org-N (was checked-by-N).
        fireEvent.press(getByTestId('fact-check-0-org-1'));
        expect(mockOpenInAppBrowser).toHaveBeenCalledWith('https://factcheck.afp.com/b');
    });

    it('renders a real published rating verbatim, not as "Unclear"', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({
                payload: {
                    ...storedRow().payload,
                    checkedBy: [{ organisation: 'PolitiFact', url: 'https://politifact.com/x', verdict: 'Mostly False' }],
                },
            })],
        });
        const { getByText, queryByText } = renderPanel();
        expect(getByText('Mostly False')).toBeTruthy();
        expect(queryByText('factCheck.assessment.unknown')).toBeNull();
    });

    it('says so plainly when no organisation covered the story', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({ payload: { ...storedRow().payload, checkedBy: [] } })],
        });
        const { getByText } = renderPanel();
        expect(getByText('factCheck.noCheckedBy')).toBeTruthy();
    });

    // The regression the stopped agent introduced — restored: a complete check
    // with zero citations must say so, not silently show a bare disclaimer.
    it('warns when a check came back with no sources at all', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({ payload: { ...storedRow().payload, citations: [] } })],
        });
        const { getByText } = renderPanel();
        expect(getByText('factCheck.noCitations')).toBeTruthy();
    });

    // ── F2's honest "searched and found nothing to synthesise from" outcome ──
    // The runner legitimately writes exactly this: status complete, verdict
    // unverifiable, and every array empty, when the ClaimReview lookup and the
    // web search both ran but turned up nothing usable — no model is even
    // called. This must render as a real, hedged answer, never a blank or
    // near-blank card.
    it('renders a real answer — not a blank card — for complete/unverifiable with every array empty', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({
                verdict: 'unverifiable',
                payload: {
                    _id: 'fc1',
                    status: 'complete',
                    verdict: 'unverifiable',
                    summary: null,
                    claims: [],
                    citations: [],
                    checkedBy: [],
                    checkedByStatus: 'searched',
                },
            })],
        });
        const { getByTestId, getByText } = renderPanel();
        expect(getByTestId('fact-check-panel')).toBeTruthy();
        expect(getByTestId('fact-check-0-verdict')).toBeTruthy();
        expect(getByText('factCheck.verdict.unverifiable.label')).toBeTruthy();
        expect(getByText('factCheck.verdict.unverifiable.detail')).toBeTruthy();
        expect(getByText('factCheck.noCheckedBy')).toBeTruthy();
        expect(getByText('factCheck.noCitations')).toBeTruthy();
        expect(getByText('factCheck.disclaimer')).toBeTruthy();
    });

    // ── The checkedBy tri-state (F2) ─────────────────────────────────────────
    // An empty `checkedBy[]` has two unrelated causes and the copy must not
    // conflate them: `searched` is a real "nobody has published" answer,
    // `unavailable` means the lookup never happened and we know nothing.
    it('says "nobody has published" only when the lookup actually ran (searched + empty)', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({
                payload: { ...storedRow().payload, checkedBy: [], checkedByStatus: 'searched' },
            })],
        });
        const { getByText, queryByText } = renderPanel();
        expect(getByText('factCheck.noCheckedBy')).toBeTruthy();
        expect(queryByText('factCheck.checkedByUnavailable')).toBeNull();
    });

    it('treats an undefined checkedByStatus (a pre-tri-state stored row) as searched', () => {
        const payload = { ...storedRow().payload, checkedBy: [] } as Record<string, unknown>;
        delete payload.checkedByStatus;
        hookState({ phase: 'terminal', rows: [storedRow({ payload })] });
        const { getByText, queryByText } = renderPanel();
        expect(getByText('factCheck.noCheckedBy')).toBeTruthy();
        expect(queryByText('factCheck.checkedByUnavailable')).toBeNull();
    });

    it('NEVER claims nobody published when the lookup was unavailable — the fabricated-all-clear this feature exists to prevent', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({
                payload: { ...storedRow().payload, checkedBy: [], checkedByStatus: 'unavailable' },
            })],
        });
        const { getByText, queryByText, getByTestId } = renderPanel();
        expect(getByTestId('fact-check-0-checked-by-unavailable')).toBeTruthy();
        expect(getByText('factCheck.checkedByUnavailable')).toBeTruthy();
        expect(queryByText('factCheck.noCheckedBy')).toBeNull();
        // The narrative verdict and its sources still render — an unavailable
        // Tier 1 lookup must not suppress the Tier 2 answer we DO have.
        expect(getByTestId('fact-check-0-verdict')).toBeTruthy();
        expect(getByTestId('fact-check-0-citation-0')).toBeTruthy();
    });

    it('shows real organisations when checkedBy is populated, regardless of checkedByStatus', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({
                payload: {
                    ...storedRow().payload,
                    checkedByStatus: 'unavailable',
                    checkedBy: [{ organisation: 'Full Fact', url: 'https://fullfact.org/a', verdict: 'disputed' }],
                },
            })],
        });
        const { getByText, queryByText } = renderPanel();
        expect(getByText('Full Fact')).toBeTruthy();
        expect(queryByText('factCheck.checkedByUnavailable')).toBeNull();
        expect(queryByText('factCheck.noCheckedBy')).toBeNull();
    });

    it('renders the blocked terminal state instead of a verdict', () => {
        hookState({ phase: 'terminal', rows: [storedRow({ status: 'blocked', verdict: null })] });
        const { getByText, queryByTestId } = renderPanel();
        expect(getByText('factCheck.blocked')).toBeTruthy();
        expect(queryByTestId('fact-check-0-verdict')).toBeNull();
    });

    // Several checks per article now stack — post-v52 an article can carry one
    // row per claim the user picked.
    it('stacks several terminal rows, one card per claim', () => {
        hookState({
            phase: 'terminal',
            rows: [
                storedRow({ id: 'row-0', claim: 'Claim one', verdict: 'supported' }),
                storedRow({ id: 'row-1', claim: 'Claim two', verdict: 'disputed' }),
            ],
        });
        const { getByTestId, getByText } = renderPanel();
        expect(getByTestId('fact-check-0-result')).toBeTruthy();
        expect(getByTestId('fact-check-1-result')).toBeTruthy();
        expect(getByText('factCheck.verdict.supported.label')).toBeTruthy();
        expect(getByText('factCheck.verdict.disputed.label')).toBeTruthy();
    });

    it('shows the working indicator ABOVE an already-terminal row when a second claim is mid-check', () => {
        hookState({
            phase: 'processing',
            showProgress: true,
            rows: [
                storedRow({ id: 'row-0', claim: 'Claim one', status: 'complete', verdict: 'supported' }),
                storedRow({ id: 'row-1', claim: 'Claim two', status: 'processing', payload: null }),
            ],
        });
        const { getByTestId } = renderPanel();
        expect(getByTestId('fact-check-working')).toBeTruthy();
        expect(getByTestId('fact-check-0-result')).toBeTruthy();
    });
});
