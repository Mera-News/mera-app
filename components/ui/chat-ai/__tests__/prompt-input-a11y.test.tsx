// PromptInput accessibility states.
//
// Both assertions below cover a bug that shipped and was live for every user,
// on every blocked conversation and on every turn while a response streamed:
// the composer dimmed and stopped working, and announced no reason for it.
// `editable={false}` and gluestack's `isDisabled` are a native prop and a
// STYLING prop respectively; neither reaches the accessibility tree.

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { exposedGlyphTexts } from '@/lib/__test-helpers__/icon-glyph-a11y';

import { PromptInput } from '../index';

jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
}));

const noop = () => {};

describe('PromptInput accessibility state', () => {
    it('announces the field as disabled when it is not editable', () => {
        const { getByPlaceholderText } = render(
            <PromptInput onSubmit={noop} placeholder="ph" disabled />,
        );

        expect(getByPlaceholderText('ph').props.accessibilityState).toEqual({
            disabled: true,
        });
    });

    it('announces the field as enabled when it is editable', () => {
        const { getByPlaceholderText } = render(
            <PromptInput onSubmit={noop} placeholder="ph" />,
        );

        expect(getByPlaceholderText('ph').props.accessibilityState).toEqual({
            disabled: false,
        });
    });

    it('announces the send button as disabled while the field is EMPTY', () => {
        // The common case, and the one a tier policy never touches: an idle
        // composer with nothing typed. The button is dimmed and inert.
        const { getByLabelText } = render(
            <PromptInput onSubmit={noop} placeholder="ph" />,
        );

        expect(getByLabelText('chat.send').props.accessibilityState).toMatchObject({
            disabled: true,
        });
    });

    it('announces the send button as disabled when the composer is disabled', () => {
        const { getByLabelText } = render(
            <PromptInput onSubmit={noop} placeholder="ph" disabled />,
        );

        expect(getByLabelText('chat.send').props.accessibilityState).toMatchObject({
            disabled: true,
        });
    });
});

describe('the send button (ux2 batch 26)', () => {
    it('is a childless, labelled 44x44 frame sized by number', () => {
        // `w-9 h-9` rendered 31.5pt: NativeWind inlines rem at 14. Only a
        // numeric style is a real 44.
        const { getByLabelText } = render(<PromptInput onSubmit={noop} placeholder="ph" />);
        const send = getByLabelText('chat.send');
        const flat = StyleSheet.flatten(send.props.style) ?? {};
        expect(flat.width).toBe(44);
        expect(flat.height).toBe(44);
        expect(send.findAll((n: any) => typeof n.type === 'string' && n !== send)).toHaveLength(0);
    });

    it('its arrow is never its own StaticText', () => {
        const { UNSAFE_root } = render(<PromptInput onSubmit={noop} placeholder="ph" />);
        const glyphs = UNSAFE_root.findAll((n: any) => n.type === 'Text' && /[\uE000-\uF8FF]/.test(String(n.props.children)));
        expect(glyphs).toHaveLength(1);
        expect(exposedGlyphTexts(UNSAFE_root)).toEqual([]);
    });

    it('still sends what was typed', () => {
        const onSubmit = jest.fn();
        const { getByLabelText, getByPlaceholderText } = render(<PromptInput onSubmit={onSubmit} placeholder="ph" />);
        fireEvent.changeText(getByPlaceholderText('ph'), '  hello ');
        fireEvent.press(getByLabelText('chat.send'));
        expect(onSubmit).toHaveBeenCalledWith('hello');
    });
});
