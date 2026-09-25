/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable: RNPressable } = require('react-native');
    return { Pressable: RNPressable };
});
jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: RNText };
});
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text: RNText } = require('react-native');
    return { __esModule: true, default: ({ text }: any) => <RNText>{text}</RNText> };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (props: any) => <View testID={`icon-${props.name}`} {...props} /> };
});
let mockEventIcon: string | null = null;
jest.mock('@/components/custom/for-you/event-type-icons', () => ({
    eventTypeIcon: () => mockEventIcon,
}));

import FactSectionHeader from '../FactSectionHeader';

describe('FactSectionHeader', () => {
    // The header's open affordance is now an ICON-ONLY round arrow — the count
    // moved to the section's closing "View all N articles" row so it isn't shown
    // twice. Icon-only means the label is the only thing VoiceOver can announce,
    // so it must still name the destination AND the count.
    it('renders a round open button labelled with the destination and count', () => {
        const { getByTestId } = render(
            <FactSectionHeader title="Elections" eventType={null} total={12} onPress={jest.fn()} />,
        );
        const btn = getByTestId('dashboard-section-open');
        expect(btn.props.accessibilityLabel).toBe('forYou.viewAllArticles');
        expect(btn.props.accessibilityRole).toBe('button');
    });

    it('no longer draws the article count in the header', () => {
        const { queryByText } = render(
            <FactSectionHeader title="Elections" eventType={null} total={12} onPress={jest.fn()} />,
        );
        expect(queryByText('forYou.articlesCount')).toBeNull();
        expect(queryByText('12')).toBeNull();
    });

    it('no longer renders a "+N new" badge', () => {
        const { queryByText } = render(
            <FactSectionHeader title="Elections" eventType={null} total={12} onPress={jest.fn()} />,
        );
        expect(queryByText('+3')).toBeNull();
        expect(queryByText('+12')).toBeNull();
    });

    // Headline sections (P5) reuse this header with two opt-outs: they are not
    // "News about:" anything, and their title is app copy already in the
    // reader's language.
    it('renders the "News about:" prefix by default', () => {
        const { getByText } = render(
            <FactSectionHeader title="Elections" eventType={null} total={5} onPress={jest.fn()} />,
        );
        expect(getByText('forYou.sectionPrefix')).toBeTruthy();
    });

    it('omits the prefix row entirely when prefix is null', () => {
        const { queryByText, getByText } = render(
            <FactSectionHeader
                title="Around the world"
                eventType={null}
                total={5}
                onPress={jest.fn()}
                prefix={null}
                translateTitle={false}
            />,
        );
        expect(queryByText('forYou.sectionPrefix')).toBeNull();
        expect(getByText('Around the world')).toBeTruthy();
    });

    it('renders no open affordance for a section with no destination', () => {
        const { queryByTestId } = render(
            <FactSectionHeader title="Around the world" eventType={null} total={0} prefix={null} />,
        );
        expect(queryByTestId('dashboard-section-open')).toBeNull();
    });

    it('the round button opens the fact feed on tap', () => {
        const onPress = jest.fn();
        const { getByTestId } = render(
            <FactSectionHeader title="Elections" eventType={null} total={5} onPress={onPress} />,
        );
        fireEvent.press(getByTestId('dashboard-section-open'));
        expect(onPress).toHaveBeenCalled();
    });
});

// Captured: the section header's arrow surfaced as its own StaticText holding
// only an icon-font glyph. A standalone glyph is decoration: hidden from
// accessibility the documented way on both platforms.
describe('section header glyphs are hidden from accessibility', () => {
    const HIDDEN = { includeHiddenElements: true } as const;
    const hiddenGlyph = (n: any) => {
        expect(n.props.accessible).toBe(false);
        expect(n.props.accessibilityElementsHidden).toBe(true);
        expect(n.props.importantForAccessibility).toBe('no-hide-descendants');
    };
    afterEach(() => {
        mockEventIcon = null;
    });

    it('hides the round open arrow and the event-type icon', () => {
        mockEventIcon = 'how-to-vote';
        const r = render(<FactSectionHeader title="Elections" eventType="election" total={12} onPress={jest.fn()} />);
        hiddenGlyph(r.getByTestId('icon-arrow-forward', HIDDEN));
        hiddenGlyph(r.getByTestId('icon-how-to-vote', HIDDEN));
        // The button itself still speaks.
        expect(r.getByTestId('dashboard-section-open').props.accessibilityLabel).toBeTruthy();
    });

    it('hides the View all row chevron', () => {
        const SectionViewAllText = require('../SectionViewAllText').default;
        const r = render(<SectionViewAllText total={12} onPress={jest.fn()} />);
        hiddenGlyph(r.getByTestId('icon-chevron-right', HIDDEN));
    });

    // Captured (batch 26): the chevron still surfaced as its own StaticText
    // after the labelled "View all" button, hidden props and all, because it
    // sat inside the button. It is now drawn under a childless labelled button.
    it('keeps the View all chevron OUTSIDE the button, under no accessible element', () => {
        const SectionViewAllText = require('../SectionViewAllText').default;
        const r = render(<SectionViewAllText total={51} onPress={jest.fn()} />);
        const button = r.getByTestId('dashboard-view-all');
        expect(button.props.accessibilityLabel).toBe('forYou.viewAllArticles');
        expect(button.findAll((n: any) => typeof n.props?.testID === 'string' && n.props.testID.startsWith('icon-'))).toHaveLength(0);
        const chevron = r.getByTestId('icon-chevron-right', HIDDEN);
        for (let p: any = chevron.parent; p; p = p.parent) expect(p.props?.accessible).not.toBe(true);
    });

    // Captured (batch 22): iOS still surfaced the arrow as its own 20x20
    // StaticText although the glyph carried the hidden props, because it sat
    // INSIDE the button's subtree. The button is now a childless accessible
    // element laid over the visual circle, so the glyph is outside it.
    it('keeps the arrow glyph OUTSIDE the button: the button is one childless labelled element', () => {
        const r = render(<FactSectionHeader title="Elections" eventType={null} total={33} onPress={jest.fn()} />);
        const button = r.getByTestId('dashboard-section-open');
        expect(button.props.accessibilityLabel).toBeTruthy();
        expect(button.props.accessibilityRole).toBe('button');
        expect(button.findAll((n: any) => typeof n.props?.testID === 'string' && n.props.testID.startsWith('icon-'))).toHaveLength(0);
        const arrow = r.getByTestId('icon-arrow-forward', HIDDEN);
        for (let p: any = arrow.parent; p; p = p.parent) expect(p).not.toBe(button);
    });

    it('still gives the button a 44pt target', () => {
        const { StyleSheet } = require('react-native');
        const r = render(<FactSectionHeader title="Elections" eventType={null} total={33} onPress={jest.fn()} />);
        const b = r.getByTestId('dashboard-section-open');
        const st = StyleSheet.flatten(b.props.style);
        const hit = b.props.hitSlop ?? { top: 0, bottom: 0, left: 0, right: 0 };
        const h = (st.height ?? 0) + (typeof hit === 'number' ? 2 * hit : (hit.top ?? 0) + (hit.bottom ?? 0));
        expect(h).toBeGreaterThanOrEqual(44);
    });
});
