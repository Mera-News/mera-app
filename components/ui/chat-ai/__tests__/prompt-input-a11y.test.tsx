// PromptInput accessibility states.
//
// Both assertions below cover a bug that shipped and was live for every user,
// on every blocked conversation and on every turn while a response streamed:
// the composer dimmed and stopped working, and announced no reason for it.
// `editable={false}` and gluestack's `isDisabled` are a native prop and a
// STYLING prop respectively; neither reaches the accessibility tree.

import React from 'react';
import { render } from '@testing-library/react-native';

import { PromptInput } from '../index';

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
}));

// The gluestack Button drags in ActivityIndicator, whose native-component
// shim does not resolve under this jest environment. The button is exercised
// here purely for the props it forwards to the a11y tree, so a host-view stand
// in that preserves them is the right level of fidelity.
jest.mock('@/components/ui/button', () => {
    const { Pressable } = jest.requireActual('react-native');
    return {
        Button: ({ children, isDisabled, ...rest }: Record<string, unknown> & {
            children?: React.ReactNode;
            isDisabled?: boolean;
        }) => <Pressable {...rest}>{children}</Pressable>,
        ButtonText: ({ children }: { children?: React.ReactNode }) => children,
    };
});

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
