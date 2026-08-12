import { render } from '@testing-library/react-native';
import React from 'react';
import VerdictIcon from '@/components/custom/fact-checks/VerdictIcon';
import { describeVerdict } from '@/lib/fact-check/fact-check-state';

jest.mock('lucide-react-native', () => ({
    ShieldCheck: (p: object) => {
        const { View } = require('react-native');
        return <View testID="shield-check" {...p} />;
    },
    ShieldAlert: (p: object) => {
        const { View } = require('react-native');
        return <View testID="shield-alert" {...p} />;
    },
    ShieldQuestionMark: (p: object) => {
        const { View } = require('react-native');
        return <View testID="shield-question" {...p} />;
    },
}));

describe('VerdictIcon', () => {
    it.each([
        ['positive', 'shield-check'],
        ['caution', 'shield-alert'],
        ['neutral', 'shield-question'],
    ] as const)('%s → %s', (tone, testID) => {
        const { getByTestId } = render(<VerdictIcon tone={tone} />);
        expect(getByTestId(testID)).toBeTruthy();
    });

    // THE POINT OF KEYING ON TONE. `disputed`, `unsupported` and `mixed` are
    // three different verdicts that all mean "there is a problem here". Keying
    // the icon on the verdict would give them three different-looking answers,
    // and would let the shield and the colour beside it disagree.
    it('gives every problem verdict the SAME shield', () => {
        const shields = ['disputed', 'unsupported', 'mixed'].map((verdict) => {
            const { getByTestId } = render(
                <VerdictIcon tone={describeVerdict(verdict).tone} />,
            );
            return getByTestId('shield-alert');
        });
        expect(shields).toHaveLength(3);
    });

    it('routes the real verdicts to the shield their tone implies', () => {
        // Reads through `describeVerdict` rather than restating the map, so a
        // verdict re-toned there cannot leave this test asserting the old shape.
        const iconFor = (verdict: string) => {
            const { queryByTestId } = render(
                <VerdictIcon tone={describeVerdict(verdict).tone} />,
            );
            if (queryByTestId('shield-check')) return 'check';
            if (queryByTestId('shield-alert')) return 'alert';
            return 'question';
        };
        expect(iconFor('supported')).toBe('check');
        expect(iconFor('unverifiable')).toBe('question');
        expect(iconFor('disputed')).toBe('alert');
        // An unrecognised verdict must not crash or claim a finding.
        expect(iconFor('something-new')).toBe('question');
    });

    it('defaults its colour from the tone, and lets a caller override', () => {
        const { getByTestId, rerender } = render(<VerdictIcon tone="positive" />);
        expect(getByTestId('shield-check').props.color).toBe('rgb(52, 131, 82)');

        rerender(<VerdictIcon tone="positive" color="#ffffff" />);
        expect(getByTestId('shield-check').props.color).toBe('#ffffff');
    });
});
