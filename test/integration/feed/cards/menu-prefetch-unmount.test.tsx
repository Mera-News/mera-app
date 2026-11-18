// The ••• sheet prefetches the feedback tree a moment after it opens. A row that goes away first
// must not start that read: it reaches storage and the database for a sheet nobody can see.
import React from 'react';
import { Pressable } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useArticleMenu } from '@/components/custom/cards/use-article-menu';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return {
        __esModule: true,
        default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
            visible ? <View>{children}</View> : null,
    };
});
jest.mock('react-native-reanimated', () => {
    const actual = jest.requireActual('react-native-reanimated/mock');
    return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => true };
});
jest.mock('react-native-safe-area-context', () => ({
    ...jest.requireActual('react-native-safe-area-context/jest/mock').default,
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 47, bottom: 34, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } },
}));

const SUBJECT: FeedbackSubject = {
    origin: 'article',
    surface: 'detail',
    articleId: 'prefetch-1',
    title: 'A headline',
    publicationName: 'Example Courier',
    countryCode: 'NLD',
    languageCode: 'en',
};

function Card({ resolveTreeContext }: { readonly resolveTreeContext: () => Promise<never> }) {
    const rowActions = React.useMemo(() => ({ answered: null, saved: false, onToggleSave: () => {}, onShare: () => {} }), []);
    const menu = useArticleMenu({ subject: SUBJECT, rowActions: rowActions as never, resolveTreeContext });
    return (
        <>
            <Pressable testID="open-menu" onPress={() => menu.open()} />
            {menu.element}
        </>
    );
}

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeAll(initI18nEn);

it('reads the tree context a moment after the sheet opens', async () => {
    const resolve = jest.fn(() => new Promise<never>(() => {}));
    await render(<Card resolveTreeContext={resolve} />);
    await act(async () => {
        fireEvent.press(screen.getByTestId('open-menu'));
    });
    await wait(600);
    expect(resolve).toHaveBeenCalledTimes(1);
});

it('starts no read once the row has gone', async () => {
    const resolve = jest.fn(() => new Promise<never>(() => {}));
    await render(<Card resolveTreeContext={resolve} />);
    await act(async () => {
        fireEvent.press(screen.getByTestId('open-menu'));
    });
    await screen.unmount();
    await wait(600);
    expect(resolve).not.toHaveBeenCalled();
});
