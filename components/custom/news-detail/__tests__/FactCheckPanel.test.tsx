jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ text, numberOfLines }: { text: string; numberOfLines?: number }) => (
      <Text numberOfLines={numberOfLines}>{text}</Text>
    ),
  };
});

// FactCheckPanel — a PURE OBSERVER post-pivot. No action button, no retry, no
// hide: the tick (`requestArticleFactCheck`) and the article mirror are the
// only ways in, and this component
// only ever renders what `useFactCheck` reads back off the device (plus its
// server poll). Properties pinned here because nothing else enforces them:
//   • absent renders nothing at all;
//   • a processing row below the progress delay renders nothing (no flash);
//   • the hedging disclaimer and the citation list render with EVERY row;
//   • an insecure citation is shown but never opened;
//   • several terminal rows STACK — one card per claim;
//   • EXTERNALS ARE THE AUTHORITY — the chip and body never present a verdict
//     of Mera's own, in any state (fc-relevance wave).
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

// The panel now starts CLOSED: the header carries the finding as a badge and
// the body is one tap away. Most tests here are about the BODY, so this helper
// opens every card it finds. Tests that are about the collapse itself, or
// about the header chip alone, use `renderClosed` below and drive the toggle
// themselves.
const renderClosed = () => render(<FactCheckPanel articleId="a1" />);

const renderPanel = () => {
    const utils = renderClosed();
    for (const toggle of utils.queryAllByTestId(/-toggle$/)) {
        fireEvent.press(toggle);
    }
    return utils;
};

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

    // ── Collapse. A verdict card is tall — organisations, our reading, every
    // claim, the sources and the disclaimer — and on a phone it can bury the
    // article the reader opened. ───────────────────────────────────────────
    describe('collapsing a card', () => {
        it('starts EXPANDED — a result the user asked for never arrives hidden', () => {
            hookState({ phase: 'terminal', rows: [storedRow()] });
            const { getByTestId, getByText } = renderPanel();
            expect(getByTestId('fact-check-0-toggle').props.accessibilityState.expanded).toBe(true);
            expect(getByText('Two other outlets report the same figures.')).toBeTruthy();
        });

        it('folds the body away but KEEPS the header, so the check is still visibly there', () => {
            hookState({ phase: 'terminal', rows: [storedRow()] });
            const { getByTestId, queryByText, getByText } = renderPanel();

            fireEvent.press(getByTestId('fact-check-0-toggle'));

            // Body gone...
            expect(queryByText('Two other outlets report the same figures.')).toBeNull();
            expect(queryByText('factCheck.disclaimer')).toBeNull();
            // ...header stays. Removing the row outright would read as the
            // fact check having failed or vanished, which is the one thing
            // hiding it must not look like.
            expect(getByText('The dam was completed in 2019.')).toBeTruthy();
            expect(getByTestId('fact-check-0-toggle').props.accessibilityState.expanded).toBe(false);
        });

        it('re-opens on a second tap', () => {
            hookState({ phase: 'terminal', rows: [storedRow()] });
            const { getByTestId, getByText } = renderPanel();
            fireEvent.press(getByTestId('fact-check-0-toggle'));
            fireEvent.press(getByTestId('fact-check-0-toggle'));
            expect(getByText('Two other outlets report the same figures.')).toBeTruthy();
        });

        it('collapses ONE card without touching its sibling', () => {
            // Keyed by row id, not index, so a second check arriving cannot
            // slide the collapsed state onto a different card.
            hookState({
                phase: 'terminal',
                rows: [
                    storedRow({ id: 'row-0', claim: 'First claim.' }),
                    storedRow({
                        id: 'row-1',
                        claim: 'Second claim.',
                        payload: { ...storedRow().payload, summary: 'A different summary.' },
                    }),
                ],
            });
            const { getByTestId, queryByText, getByText } = renderPanel();

            fireEvent.press(getByTestId('fact-check-0-toggle'));

            expect(queryByText('Two other outlets report the same figures.')).toBeNull();
            expect(getByText('A different summary.')).toBeTruthy();
            expect(getByTestId('fact-check-1-toggle').props.accessibilityState.expanded).toBe(true);
        });
    });

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

    it('renders a terminal result for a cached check, no action button anywhere', () => {
        hookState({ phase: 'terminal', rows: [storedRow()] });
        const { getByTestId, queryByTestId } = renderPanel();
        expect(getByTestId('fact-check-panel')).toBeTruthy();
        expect(queryByTestId('spinner')).toBeNull();
        // Default fixture has an empty, searched `checkedBy` — the chip says
        // so plainly. See the "when checkedBy is populated" describe block
        // below for the organisation-led branch.
        expect(getByTestId('fact-check-0-none-found-header')).toBeTruthy();
        // The retired full-width action button is gone for good — there is
        // exactly one way in now, the action-row tick.
        expect(queryByTestId('fact-check-action')).toBeNull();
    });

    it('always shows the hedging disclaimer and the citations', () => {
        hookState({ phase: 'terminal', rows: [storedRow()] });
        const { getByText, getByTestId } = renderPanel();
        expect(getByText('factCheck.disclaimer')).toBeTruthy();
        expect(getByText('factCheck.citationsHeading')).toBeTruthy();
        expect(getByTestId('fact-check-0-citation-0')).toBeTruthy();
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

    it('includes the organisation rating in its link accessibility label', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({
                payload: {
                    ...storedRow().payload,
                    checkedBy: [{ organisation: 'Full Fact', url: 'https://fullfact.org/a', verdict: 'disputed' }],
                },
            })],
        });
        const { getByTestId } = renderPanel();
        const label = getByTestId('fact-check-0-org-0').props.accessibilityLabel as string;
        expect(label).toContain('factCheck.organisationA11y');
        expect(label).toContain('Full Fact');
        expect(label).toContain('factCheck.assessment.disputed');
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
    // near-blank card. Mera's own section falls back to `searchFoundEmpty`
    // rather than a verdict-bucket sentence — see the file header on why
    // `describeVerdict` is no longer this component's concern at all.
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
        expect(getByTestId('fact-check-0-none-found-header')).toBeTruthy();
        expect(getByText('factCheck.searchFoundHeading')).toBeTruthy();
        expect(getByText('factCheck.searchFoundEmpty')).toBeTruthy();
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

    // `unavailable` now OUTRANKS `none-published` in the CHIP, which looks
    // like a revert of the earlier tier-1/tier-2 correction and is not — see
    // `describeExternalChecks`'s own comment. That correction moved
    // `unavailable` below Mera's own verdict because a tier-1 outage must not
    // suppress a tier-2 answer we actually held. There is no tier-2 answer on
    // this chip any more (fc-relevance wave), so nothing is being suppressed:
    // the only remaining question is whether the organisation lookup ran.
    it('NEVER claims nobody published when the lookup was unavailable — the fabricated-all-clear this feature exists to prevent', () => {
        hookState({
            phase: 'terminal',
            rows: [storedRow({
                payload: { ...storedRow().payload, checkedBy: [], checkedByStatus: 'unavailable' },
            })],
        });
        const { getByText, queryByText, getByTestId, queryByTestId } = renderPanel();
        expect(getByTestId('fact-check-0-unavailable-header')).toBeTruthy();
        expect(queryByTestId('fact-check-0-none-found-header')).toBeNull();
        expect(getByTestId('fact-check-0-checked-by-unavailable')).toBeTruthy();
        expect(getByText('factCheck.checkedByUnavailable')).toBeTruthy();
        expect(queryByText('factCheck.noCheckedBy')).toBeNull();
        // Mera's OWN evidence section — the search-found summary and
        // citations — still renders in full. An unavailable Tier 1 lookup
        // must not suppress it.
        expect(getByText('factCheck.searchFoundHeading')).toBeTruthy();
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

    // ── fc-relevance wave — EXTERNALS ARE THE AUTHORITY, and Mera's own
    // verdict never styles or words the chip or the body, in ANY state. This
    // supersedes PIVOT P8h in the opposite direction from an earlier plan for
    // this wave (own verdict always leads): that still failed on an
    // off-topic external outranking a TRUE story, just with the roles
    // reversed — a real screenshot caught exactly the mirror-image defect
    // (see the file header). Removing Mera's verdict from the chip and body
    // entirely, rather than re-ranking it against externals, is what these
    // tests pin. ─────────────────────────────────────────────────────────────
    describe('when checkedBy is populated', () => {
        const withOrg = (verdict: string, extra: Record<string, unknown> = {}) => storedRow({
            verdict,
            payload: {
                ...storedRow().payload,
                verdict,
                checkedBy: [{ organisation: 'Alt News', url: 'https://altnews.in/x', verdict: 'False' }],
                ...extra,
            },
        });

        // ── THE MUST-FAIL TEST ───────────────────────────────────────────────
        // Sabotaged (see report), this must go RED if Mera's own verdict is
        // ever allowed to own the chip or lead the body again, in any state.
        it('the organisation leads everywhere and Mera never renders a verdict of its own — even when its own reading is unverifiable', () => {
            hookState({ phase: 'terminal', rows: [withOrg('unverifiable')] });
            const { getByTestId, queryByTestId, queryByText, getByText } = renderPanel();

            expect(getByTestId('fact-check-0-organisation-header')).toBeTruthy();
            expect(getByText('Alt News: False')).toBeTruthy();

            // No verdict label, chip, or "secondary" reading anywhere on the
            // card, for any verdict value — these testIDs and copy keys must
            // never exist on this component again.
            expect(queryByTestId('fact-check-0-verdict-header')).toBeNull();
            expect(queryByTestId('fact-check-0-verdict-secondary')).toBeNull();
            expect(queryByTestId('fact-check-0-none-found-header')).toBeNull();
            expect(queryByText('factCheck.verdict.unverifiable.label')).toBeNull();
            expect(queryByText('factCheck.verdict.unverifiable.detail')).toBeNull();
            expect(queryByText('factCheck.ownReadingHeading')).toBeNull();
        });

        it('renders identically for a well-evidenced verdict too — the chip and body are verdict-independent', () => {
            hookState({ phase: 'terminal', rows: [withOrg('supported')] });
            const { getByTestId, queryByTestId, getByText, queryByText } = renderPanel();

            expect(getByTestId('fact-check-0-organisation-header')).toBeTruthy();
            expect(getByText('Alt News: False')).toBeTruthy();
            expect(queryByTestId('fact-check-0-verdict-header')).toBeNull();
            expect(queryByTestId('fact-check-0-verdict-secondary')).toBeNull();
            expect(queryByText('factCheck.verdict.supported.label')).toBeNull();
        });

        it('renders the organisation list BEFORE Mera\'s own evidence in document order', () => {
            hookState({ phase: 'terminal', rows: [withOrg('supported')] });
            const { toJSON } = renderPanel();
            const tree = JSON.stringify(toJSON());
            const orgIndex = tree.indexOf('Alt News');
            const ownReadingIndex = tree.indexOf('factCheck.searchFoundHeading');
            expect(orgIndex).toBeGreaterThan(-1);
            expect(ownReadingIndex).toBeGreaterThan(-1);
            expect(orgIndex).toBeLessThan(ownReadingIndex);
        });

        it('still renders Mera\'s own evidence section, unconditionally, when checkedBy is empty', () => {
            hookState({
                phase: 'terminal',
                rows: [storedRow({
                    verdict: 'unverifiable',
                    payload: { ...storedRow().payload, verdict: 'unverifiable', checkedBy: [] },
                })],
            });
            const { getByTestId } = renderPanel();
            expect(getByTestId('fact-check-0-none-found-header')).toBeTruthy();
            // Own-reading is now an unconditional section, not gated on
            // `hasCheckedBy` any more — it renders every time the card is
            // open, whether or not any organisation was found.
            expect(getByTestId('fact-check-0-own-reading')).toBeTruthy();
        });

        it('warns that ratings may disagree once two or more organisations are listed', () => {
            hookState({
                phase: 'terminal',
                rows: [storedRow({
                    payload: {
                        ...storedRow().payload,
                        checkedBy: [
                            { organisation: 'Alt News', url: 'https://altnews.in/x', verdict: 'False' },
                            { organisation: 'BOOM', url: 'https://boomlive.in/y', verdict: 'Misleading' },
                        ],
                    },
                })],
            });
            const { getByText, getByTestId } = renderPanel();
            expect(getByTestId('fact-check-0-multiple-organisations-note')).toBeTruthy();
            expect(getByText('factCheck.checkedByMultipleNote')).toBeTruthy();
        });

        it('does NOT show the disagreement note for a single organisation', () => {
            hookState({ phase: 'terminal', rows: [withOrg('supported')] });
            const { queryByTestId } = renderPanel();
            expect(queryByTestId('fact-check-0-multiple-organisations-note')).toBeNull();
        });

        it('adds a colourless count line under the chip when more than one organisation is gated as relevant', () => {
            hookState({
                phase: 'terminal',
                rows: [storedRow({
                    payload: {
                        ...storedRow().payload,
                        checkedBy: [
                            { organisation: 'India Today', url: 'https://x', verdict: 'False' },
                            { organisation: 'AFP Fact Check', url: 'https://y', verdict: 'Misleading' },
                        ],
                    },
                })],
            });
            const { getByTestId, getByText } = renderClosed();
            expect(getByTestId('fact-check-0-organisation-header')).toBeTruthy();
            expect(getByText('India Today: False')).toBeTruthy();
            // The TOTAL count, not "count - 1 more" the way the retired
            // `moreOrganisations` key worked — "found" describes the whole
            // search result set, and the chip showing one of them doesn't
            // change how many were found.
            expect(getByTestId('fact-check-0-count-header')).toBeTruthy();
            expect(getByText('factCheck.dashboard.factChecksFound::{"count":2}')).toBeTruthy();
        });
    });

    it('renders the blocked terminal state instead of a verdict', () => {
        hookState({ phase: 'terminal', rows: [storedRow({ status: 'blocked', verdict: null })] });
        const { getByText, queryByTestId } = renderPanel();
        expect(getByText('factCheck.blocked')).toBeTruthy();
        expect(queryByTestId('fact-check-0-verdict-header')).toBeNull();
        expect(queryByTestId('fact-check-0-none-found-header')).toBeNull();
        expect(queryByTestId('fact-check-0-organisation-header')).toBeNull();
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
        expect(getByText('Claim one')).toBeTruthy();
        expect(getByText('Claim two')).toBeTruthy();
    });

    // ── The r14-shaped bug this pivot must not reintroduce ──────────────────
    // A poll that gives up must render something DIFFERENT from both "nobody
    // asked" (absent → null) and "checked, nothing to show" (a terminal row
    // with an empty checkedBy still renders a full card). This test FAILS if
    // 'stalled' is ever treated the same as 'absent': absent renders `null`
    // from `toJSON()`, so asserting a non-null tree here is exactly the
    // assertion that distinguishes "gave up" from "no result".
    it('renders a distinguishable "still checking" state when the poll gives up — never identical to absent/no-result', () => {
        hookState({ phase: 'stalled', showProgress: false, rows: [storedRow({ status: 'pending', payload: null })] });
        const { toJSON, getByTestId, getByText, queryByTestId } = renderPanel();
        expect(toJSON()).not.toBeNull();
        expect(getByTestId('fact-check-panel')).toBeTruthy();
        expect(getByTestId('fact-check-stalled')).toBeTruthy();
        expect(getByText('factCheck.stillChecking')).toBeTruthy();
        // Not the working block's copy — that promises an imminent answer,
        // which is no longer honest once the poll has actually given up.
        expect(queryByTestId('fact-check-working')).toBeNull();
        // Not a fabricated terminal result either — the row is `pending`, so
        // it never reaches `terminalRows` and no per-row chip exists at all.
        expect(queryByTestId('fact-check-0-none-found-header')).toBeNull();
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

    // ── The header accessibility label — new this wave. An explicit
    // accessibilityLabel on a Pressable swallows every descendant Text's own
    // announcement, so without composing one a screen reader heard only
    // "Show this fact check" and never the title or the chip's finding. ────
    describe('the header accessibility label', () => {
        it('composes title, status and action into one label', () => {
            hookState({ phase: 'terminal', rows: [storedRow({ claim: 'A specific claim.' })] });
            const { getByTestId } = renderClosed();
            const label = getByTestId('fact-check-0-toggle').props.accessibilityLabel as string;
            expect(label).toContain('factCheck.headerA11y');
            expect(label).toContain('A specific claim.');
            expect(label).toContain('factCheck.dashboard.noneFound');
            expect(label).toContain('factCheck.expandA11y');
        });

        it('reflects the collapse action once the card is open', () => {
            hookState({ phase: 'terminal', rows: [storedRow()] });
            const { getByTestId } = renderClosed();
            fireEvent.press(getByTestId('fact-check-0-toggle'));
            const label = getByTestId('fact-check-0-toggle').props.accessibilityLabel as string;
            expect(label).toContain('factCheck.collapseA11y');
        });

        it('carries the lead organisation into the label when one was found', () => {
            hookState({
                phase: 'terminal',
                rows: [storedRow({
                    payload: {
                        ...storedRow().payload,
                        checkedBy: [{ organisation: 'Alt News', url: 'https://altnews.in/x', verdict: 'False' }],
                    },
                })],
            });
            const { getByTestId } = renderClosed();
            const label = getByTestId('fact-check-0-toggle').props.accessibilityLabel as string;
            expect(label).toContain('Alt News: False');
        });
    });
});
