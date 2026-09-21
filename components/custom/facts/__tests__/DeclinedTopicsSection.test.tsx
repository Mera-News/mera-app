/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim — same as FactsList.test.tsx.
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

jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: ({ text, ...props }: any) => <Text {...props}>{text}</Text> };
});

jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: (p: any) => <Pressable {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
    };
});

jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return { __esModule: true, GlassPanel: (p: any) => <View {...p} /> };
});

import DeclinedTopicsSection, { type DeclinedTopicItem } from '../DeclinedTopicsSection';

const item = (overrides: Partial<DeclinedTopicItem> = {}): DeclinedTopicItem => ({
    id: 't1',
    text: 'Formula 1 gossip',
    sourceFactId: 'f1',
    ...overrides,
});

describe('DeclinedTopicsSection', () => {
    it('renders nothing — not even the header — on an empty list', () => {
        const { queryByText, toJSON } = render(
            <DeclinedTopicsSection items={[]} onAllowAgain={jest.fn()} />,
        );
        expect(queryByText('facts.declinedTopicsTitle')).toBeNull();
        expect(toJSON()).toBeNull();
    });

    it('renders one row per declined topic, using display text', () => {
        const items = [item(), item({ id: 't2', text: 'Crypto price alerts' })];
        const { getByText } = render(<DeclinedTopicsSection items={items} onAllowAgain={jest.fn()} />);
        expect(getByText('facts.declinedTopicsTitle')).toBeTruthy();
        expect(getByText('Formula 1 gossip')).toBeTruthy();
        expect(getByText('Crypto price alerts')).toBeTruthy();
    });

    it('never renders the normalized form, only the display text', () => {
        // A row whose `text` happens to differ from what a normalizer would
        // produce (case, whitespace) must still render `text` verbatim — this
        // component has no normalizedText field at all, so there is nothing to
        // accidentally render instead, but the case is worth pinning since the
        // whole point of the `text` column (per P3's plan) is that the
        // normalised form must never reach this screen.
        const { getByText, queryByText } = render(
            <DeclinedTopicsSection
                items={[item({ text: 'Formula 1  Gossip' })]}
                onAllowAgain={jest.fn()}
            />,
        );
        expect(getByText('Formula 1  Gossip')).toBeTruthy();
        expect(queryByText('formula 1 gossip')).toBeNull();
    });

    it('pressing "Allow this again" calls onAllowAgain with the pressed item, exactly once', () => {
        const onAllowAgain = jest.fn();
        const target = item();
        const other = item({ id: 't2', text: 'Crypto price alerts' });
        const { getByTestId } = render(
            <DeclinedTopicsSection items={[target, other]} onAllowAgain={onAllowAgain} />,
        );
        fireEvent.press(getByTestId('declined-topic-allow-t1'));
        expect(onAllowAgain).toHaveBeenCalledTimes(1);
        expect(onAllowAgain).toHaveBeenCalledWith(target);
    });

    it('passes sourceFactId through on the item so the host can decide whether to re-mint', () => {
        // This component makes no re-mint decision itself (see the file's own
        // doc comment) — it just has to not lose the field the host needs to
        // make that call.
        const onAllowAgain = jest.fn();
        const withFact = item({ sourceFactId: 'f42' });
        const withoutFact = item({ id: 't2', sourceFactId: null });
        const { getByTestId } = render(
            <DeclinedTopicsSection items={[withFact, withoutFact]} onAllowAgain={onAllowAgain} />,
        );
        fireEvent.press(getByTestId('declined-topic-allow-t2'));
        expect(onAllowAgain).toHaveBeenCalledWith(expect.objectContaining({ sourceFactId: null }));
    });
});
