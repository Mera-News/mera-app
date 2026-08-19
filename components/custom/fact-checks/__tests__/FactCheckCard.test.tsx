jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ text, numberOfLines }: { text: string; numberOfLines?: number }) => (
      <Text numberOfLines={numberOfLines}>{text}</Text>
    ),
  };
});

// FactCheckCard — tap-to-open + delete, and the separation between them.
//
// The property worth a build over: DELETE MUST NOT ALSO NAVIGATE. That is the
// standard bug when a row gains an onPress, and its failure mode here is nasty
// — the row is destroyed while a detail screen opens over it, so the user sees
// a screen they didn't ask for and loses the card they meant to keep.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, opts?: Record<string, unknown>) =>
            opts ? `${key}::${JSON.stringify(opts)}` : key,
    }),
}));

const mockOpenInAppBrowser = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('@/lib/web-browser-utils', () => ({
    openInAppBrowser: (...a: unknown[]) => mockOpenInAppBrowser(...a),
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
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import FactCheckCard from '../FactCheckCard';

const stored = (overrides: Record<string, unknown> = {}) => ({
    id: 'row1',
    articleId: 'a1',
    factCheckId: 'fc1',
    articleTitle: 'A headline',
    status: 'complete',
    verdict: 'supported',
    payload: {
        _id: 'fc1',
        status: 'complete',
        verdict: 'supported',
        checkedBy: [
            { organisation: 'Full Fact', url: 'https://fullfact.org/a', verdict: 'disputed' },
        ],
    },
    requestedAt: 1,
    resolvedAt: 2,
    ...overrides,
}) as any;

describe('FactCheckCard', () => {
    beforeEach(() => jest.clearAllMocks());

    it('opens the article when the card body is tapped', () => {
        const onPress = jest.fn();
        const { getByTestId } = render(
            <FactCheckCard item={stored()} onPress={onPress} testIDPrefix="fc" />,
        );
        fireEvent.press(getByTestId('fc-open-row1'));
        expect(onPress).toHaveBeenCalledTimes(1);
        // The WHOLE row is handed back — the caller needs `articleId`.
        expect(onPress.mock.calls[0][0].articleId).toBe('a1');
    });

    // ── The bug this test exists for ────────────────────────────────────────
    it('deletes WITHOUT also navigating', () => {
        const onPress = jest.fn();
        const onDelete = jest.fn();
        const { getByTestId } = render(
            <FactCheckCard item={stored()} onPress={onPress} onDelete={onDelete} testIDPrefix="fc" />,
        );
        fireEvent.press(getByTestId('fc-delete-row1'));
        expect(onDelete).toHaveBeenCalledWith('row1');
        expect(onPress).not.toHaveBeenCalled();
    });

    // The card is COMPACT: organisation LINKS, citations, Mera's own reading,
    // the claims and the disclaimer all live on the article screen this row
    // opens. Nothing inside the body is independently tappable any more, so
    // the whole row is one target and a tap can only mean "open the article".
    it('renders no tappable source links — the body is one target', () => {
        const onPress = jest.fn();
        const { queryByTestId, getByTestId } = render(
            <FactCheckCard item={stored()} onPress={onPress} testIDPrefix="fc" />,
        );
        expect(queryByTestId('fc-org-0')).toBeNull();
        fireEvent.press(getByTestId('fc-open-row1'));
        expect(onPress).toHaveBeenCalledTimes(1);
        expect(mockOpenInAppBrowser).not.toHaveBeenCalled();
    });

    // The article-detail "no longer available" state renders the card with no
    // onPress — there is nowhere further to go from there.
    it('is inert, and exposes no button role, when no onPress is given', () => {
        const { getByTestId } = render(
            <FactCheckCard item={stored()} testIDPrefix="fc" />,
        );
        const body = getByTestId('fc-open-row1');
        expect(body.props.accessibilityRole).toBeUndefined();
        // Pressing must not throw and must have no effect.
        fireEvent.press(body);
    });

    it('renders no delete control when onDelete is omitted', () => {
        const { queryByTestId } = render(
            <FactCheckCard item={stored()} onPress={jest.fn()} testIDPrefix="fc" />,
        );
        expect(queryByTestId('fc-delete-row1')).toBeNull();
    });

    it('still renders an unresolved row as pending rather than hiding it', () => {
        const { getByTestId } = render(
            <FactCheckCard
                item={stored({ status: 'pending', verdict: null })}
                onPress={jest.fn()}
                testIDPrefix="fc"
            />,
        );
        expect(getByTestId('fc-pending')).toBeTruthy();
    });

    // F2's honest "searched and found nothing to synthesise from" outcome —
    // this card has no expandable body, so the badge itself is the whole
    // answer here: it must never be blank, but it also never renders Mera's
    // own verdict any more (EXTERNALS ARE THE AUTHORITY, fc-relevance wave —
    // see FactCheckBadge). Searched + nothing found is "none-published".
    it('shows "no published fact checks found" for complete/unverifiable with every array empty', () => {
        const { getByTestId, getByText, queryByText } = render(
            <FactCheckCard
                item={stored({
                    verdict: 'unverifiable',
                    payload: {
                        _id: 'fc1', status: 'complete', verdict: 'unverifiable',
                        summary: null, claims: [], citations: [], checkedBy: [],
                        checkedByStatus: 'searched',
                    },
                })}
                onPress={jest.fn()}
                testIDPrefix="fc"
            />,
        );
        expect(getByTestId('fc-none-found-row1')).toBeTruthy();
        expect(getByText('factCheck.dashboard.noneFound')).toBeTruthy();
        expect(queryByText('factCheck.noCheckedBy')).toBeNull();
    });

    // The checkedBy tri-state, same as FactCheckPanel — this card is a
    // SEPARATE render path (the Dashboard block and the fact-checks list) and
    // must not independently regress into claiming "nobody published" for a
    // lookup that never ran.
    //
    // `unavailable` now OUTRANKS `none-published` here, which looks like a
    // revert of an earlier correction and is not — see
    // `describeExternalChecks`'s own comment in fact-check-state.ts. The
    // earlier fix moved `unavailable` below Mera's OWN verdict, because a
    // tier-1 outage must not suppress a tier-2 answer we actually held. This
    // chip carries no tier-2 answer any more (Mera's verdict is never shown
    // here), so nothing is being suppressed: the only remaining question is
    // whether the organisation lookup ran, which is exactly what this
    // assertion checks.
    it('never claims nobody published when the ClaimReview lookup was unavailable', () => {
        const { getByText, queryByText, getByTestId, queryByTestId } = render(
            <FactCheckCard
                item={stored({
                    payload: {
                        _id: 'fc1', status: 'complete', verdict: 'unverifiable',
                        checkedBy: [], checkedByStatus: 'unavailable',
                        citations: [{ title: 'A source', uri: 'https://example.com/x' }],
                    },
                })}
                onPress={jest.fn()}
                testIDPrefix="fc"
            />,
        );
        expect(getByTestId('fc-unavailable-row1')).toBeTruthy();
        expect(getByText('factCheck.dashboard.couldNotCheck')).toBeTruthy();
        expect(queryByTestId('fc-none-found-row1')).toBeNull();
        expect(queryByText('factCheck.noCheckedBy')).toBeNull();
    });

    it('shows "no published fact checks found" when the lookup ran and found nothing', () => {
        const { getByTestId, queryByText } = render(
            <FactCheckCard
                item={stored({
                    payload: {
                        _id: 'fc1', status: 'complete', verdict: 'supported',
                        checkedBy: [], checkedByStatus: 'searched',
                    },
                })}
                onPress={jest.fn()}
                testIDPrefix="fc"
            />,
        );
        expect(getByTestId('fc-none-found-row1')).toBeTruthy();
        expect(queryByText('factCheck.dashboard.couldNotCheck')).toBeNull();
    });

    // ── fc-relevance wave — EXTERNALS ARE THE AUTHORITY, and Mera's own
    // verdict never styles or words this chip, in ANY state. This supersedes
    // PIVOT P8h in the opposite direction from an earlier plan for this wave,
    // which would have had Mera's own (well-evidenced) verdict lead instead:
    // that still failed on an off-topic external outranking a TRUE story,
    // just with the roles reversed. Removing Mera's verdict from the chip
    // entirely, rather than re-ranking it against externals, is what these
    // tests pin. ─────────────────────────────────────────────────────────────
    describe('when checkedBy is populated', () => {
        const withOrg = (verdict: string | null) => stored({
            verdict,
            payload: {
                _id: 'fc1',
                status: 'complete',
                verdict,
                checkedBy: [{ organisation: 'Alt News', url: 'https://altnews.in/x', verdict: 'False' }],
            },
        });

        // ── THE MUST-FAIL TEST (Dashboard card half) ────────────────────────
        // Sabotaged (see report), this must go RED if Mera's own verdict is
        // ever allowed to own this chip again, in any state.
        it('the organisation leads, verbatim, and Mera never renders a verdict of its own here', () => {
            const { getByTestId, queryByTestId, queryByText, getByText } = render(
                <FactCheckCard item={withOrg('unverifiable')} onPress={jest.fn()} testIDPrefix="fc" />,
            );
            expect(getByTestId('fc-organisation-row1')).toBeTruthy();
            expect(getByText('Alt News: False')).toBeTruthy();
            expect(queryByTestId('fc-none-found-row1')).toBeNull();
            expect(queryByTestId('fc-verdict-row1')).toBeNull();
            expect(queryByTestId('fc-verdict-secondary-row1')).toBeNull();
            expect(queryByText('factCheck.verdict.unverifiable.label')).toBeNull();
        });

        it('renders identically for a well-evidenced verdict too — the chip is verdict-independent', () => {
            const { getByTestId, queryByTestId, getByText, queryByText } = render(
                <FactCheckCard item={withOrg('supported')} onPress={jest.fn()} testIDPrefix="fc" />,
            );
            expect(getByTestId('fc-organisation-row1')).toBeTruthy();
            expect(getByText('Alt News: False')).toBeTruthy();
            expect(queryByTestId('fc-verdict-row1')).toBeNull();
            expect(queryByTestId('fc-none-found-row1')).toBeNull();
            expect(queryByText('factCheck.verdict.supported.label')).toBeNull();
        });

        it('still shows "no published fact checks found" when checkedBy is empty, even for the same verdict', () => {
            const { getByTestId, queryByTestId } = render(
                <FactCheckCard
                    item={stored({
                        verdict: 'supported',
                        payload: { _id: 'fc1', status: 'complete', verdict: 'supported', checkedBy: [] },
                    })}
                    onPress={jest.fn()}
                    testIDPrefix="fc"
                />,
            );
            expect(getByTestId('fc-none-found-row1')).toBeTruthy();
            expect(queryByTestId('fc-verdict-row1')).toBeNull();
            expect(queryByTestId('fc-verdict-secondary-row1')).toBeNull();
        });
    });

    // ── The organisation-names line — reachability on a surface with no
    // expandable body. New this wave. ───────────────────────────────────────
    describe('the organisation-names line', () => {
        it('lists every gated organisation name, deduped, comma-joined, first-appearance order', () => {
            const { getByTestId } = render(
                <FactCheckCard
                    item={stored({
                        payload: {
                            _id: 'fc1', status: 'complete', verdict: 'supported',
                            checkedBy: [
                                { organisation: 'India Today', url: 'https://a', verdict: 'False' },
                                { organisation: 'AFP Fact Check', url: 'https://b', verdict: 'False' },
                                { organisation: 'AFP Fact Check', url: 'https://c', verdict: 'Misleading' },
                                { organisation: 'Full Fact', url: 'https://d', verdict: 'False' },
                            ],
                        },
                    })}
                    onPress={jest.fn()}
                    testIDPrefix="fc"
                />,
            );
            const line = getByTestId('fc-org-names-row1');
            expect(line.props.children).toBe('India Today, AFP Fact Check, Full Fact');
        });

        it('renders no organisation-names line when nothing was found', () => {
            const { queryByTestId } = render(
                <FactCheckCard
                    item={stored({
                        payload: { _id: 'fc1', status: 'complete', verdict: 'supported', checkedBy: [] },
                    })}
                    onPress={jest.fn()}
                    testIDPrefix="fc"
                />,
            );
            expect(queryByTestId('fc-org-names-row1')).toBeNull();
        });
    });

    // Real-data finding: a prod organisation `verdict` can be a full sentence
    // (Full Fact's ClaimReview entries are prose, not a short rating). This
    // card uses the same FactCheckBadge as the article panel, so the same
    // one-line cap applies here too — see FactCheckBadge's file header.
    it('caps the chip to one line for a sentence-length organisation verdict', () => {
        const sentence = "The video shows the aftermath of an accidental explosion in Lebanon in 2020 and doesn't relate to the Netherlands.";
        const { getByText } = render(
            <FactCheckCard
                item={stored({
                    payload: {
                        _id: 'fc1', status: 'complete', verdict: 'supported',
                        checkedBy: [{ organisation: 'Full Fact', url: 'https://fullfact.org/x', verdict: sentence }],
                    },
                })}
                onPress={jest.fn()}
                testIDPrefix="fc"
            />,
        );
        const chipText = getByText(`Full Fact: ${sentence}`);
        expect(chipText.props.numberOfLines).toBe(1);
    });
});
