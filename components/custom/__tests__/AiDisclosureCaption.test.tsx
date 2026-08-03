// AiDisclosureCaption tests (Group C1 — EU AI Act Art. 50 transparency).
// The component is deliberately trivial (icon + text row), so these tests
// cover the contract that matters: the copy renders, the a11y label is always
// non-empty (RelevanceChip precedent — never colour-only), the `text` override
// is honoured (used by the chat thread-header notice), and the two variants
// select the expected sizing/italic treatment.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View testID="ai-disclosure-icon" {...p} /> };
});

import { render } from '@testing-library/react-native';
import React from 'react';
import AiDisclosureCaption from '../AiDisclosureCaption';

describe('AiDisclosureCaption', () => {
    it('renders the default article-disclosure copy', () => {
        const { getByText } = render(<AiDisclosureCaption />);
        expect(getByText('aiDisclosure.caption')).toBeTruthy();
    });

    it('carries a non-empty accessibilityLabel matching the shown text — never colour-only', () => {
        const { getByLabelText } = render(<AiDisclosureCaption />);
        const row = getByLabelText('aiDisclosure.caption');
        expect(row.props.accessibilityLabel).toBe('aiDisclosure.caption');
        expect(row.props.accessibilityLabel.length).toBeGreaterThan(0);
    });

    it('always renders the sparkle icon alongside the text (icon + text both carry meaning)', () => {
        const { getByTestId } = render(<AiDisclosureCaption />);
        expect(getByTestId('ai-disclosure-icon').props.name).toBe('auto-awesome');
    });

    it('honours a text override — used by the chat thread-header notice, which must not reuse the article caption verbatim', () => {
        const { getByText, queryByText } = render(
            <AiDisclosureCaption text="You're talking with Mera, an AI assistant — not a person." />,
        );
        expect(getByText("You're talking with Mera, an AI assistant — not a person.")).toBeTruthy();
        expect(queryByText('aiDisclosure.caption')).toBeNull();
    });

    it('renders smaller and non-italic in the compact variant (tracked-story inline label)', () => {
        const { getByText } = render(<AiDisclosureCaption variant="compact" />);
        const text = getByText('aiDisclosure.caption');
        expect(text.props.size).toBe('2xs');
        expect(text.props.italic).toBeFalsy();
    });

    it('defaults to the italic caption variant (reason-box caption)', () => {
        const { getByText } = render(<AiDisclosureCaption />);
        const text = getByText('aiDisclosure.caption');
        expect(text.props.size).toBe('xs');
        expect(text.props.italic).toBe(true);
    });

    // `align` exists so the reason boxes could move this caption out from under
    // the right-aligned reason text and into the LEFT column, under the priority
    // chip. The default must stay 'right' — the chat thread header is the one
    // remaining consumer that relies on it (the tracked-stories surfaces have
    // since moved to align="left", under their left-aligned headings).
    describe('align', () => {
        it('hugs the RIGHT edge by default — unchanged for the pre-existing consumers', () => {
            const { getByLabelText, getByText } = render(<AiDisclosureCaption />);
            expect(getByLabelText('aiDisclosure.caption').props.className).toContain('justify-end');
            expect(getByText('aiDisclosure.caption').props.className).toBe('text-right');
        });

        it('hugs the LEFT edge with align="left" (under the priority chip)', () => {
            const { getByLabelText, getByText } = render(<AiDisclosureCaption align="left" />);
            const row = getByLabelText('aiDisclosure.caption');
            expect(row.props.className).toContain('justify-start');
            expect(row.props.className).not.toContain('justify-end');
            expect(getByText('aiDisclosure.caption').props.className).toBe('text-left');
        });

        it('keeps appending an extra className after the alignment classes', () => {
            const { getByLabelText } = render(<AiDisclosureCaption align="left" className="mt-1" />);
            expect(getByLabelText('aiDisclosure.caption').props.className).toContain('mt-1');
        });
    });
});
