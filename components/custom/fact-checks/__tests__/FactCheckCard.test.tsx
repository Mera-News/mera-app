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

    it('opens a fact-checker link without also navigating to the article', () => {
        const onPress = jest.fn();
        const { getByTestId } = render(
            <FactCheckCard item={stored()} onPress={onPress} testIDPrefix="fc" />,
        );
        fireEvent.press(getByTestId('fc-org-0'));
        expect(mockOpenInAppBrowser).toHaveBeenCalledWith('https://fullfact.org/a');
        expect(onPress).not.toHaveBeenCalled();
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
    // same property FactCheckPanel pins: this must render a real, hedged
    // verdict, never a blank card, on the Dashboard/list surface too.
    it('renders a real answer for complete/unverifiable with every array empty', () => {
        const { getByTestId, getByText } = render(
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
        expect(getByTestId('fc-verdict-row1')).toBeTruthy();
        expect(getByText('factCheck.verdict.unverifiable.label')).toBeTruthy();
        expect(getByText('factCheck.noCheckedBy')).toBeTruthy();
    });

    // The checkedBy tri-state, same as FactCheckPanel — this card is a
    // SEPARATE render path (the Dashboard block and the fact-checks list) and
    // must not independently regress into claiming "nobody published" for a
    // lookup that never ran.
    it('never claims nobody published when the ClaimReview lookup was unavailable', () => {
        const { getByText, queryByText, getByTestId } = render(
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
        expect(getByTestId('fc-checked-by-unavailable')).toBeTruthy();
        expect(getByText('factCheck.checkedByUnavailable')).toBeTruthy();
        expect(queryByText('factCheck.noCheckedBy')).toBeNull();
    });

    it('says nobody published when the lookup actually ran and found nothing', () => {
        const { getByText, queryByText } = render(
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
        expect(getByText('factCheck.noCheckedBy')).toBeTruthy();
        expect(queryByText('factCheck.checkedByUnavailable')).toBeNull();
    });
});
