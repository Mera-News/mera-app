// Not preferred through the mounted ••• sheet, the way a finger reaches it on a publisher page's
// card: a publisher id, a visit to the feedback tree first, Back to the menu, the source level,
// the row. Mocked: the RN Modal spec, reanimated and the safe area. The sheet, hub and writer are real.
import React from 'react';
import { Platform, Pressable } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useArticleMenu } from '@/components/custom/cards/use-article-menu';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { useToast } from '@/components/ui/toast';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { __clearPublisherSourceNames, rememberPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { toastManager } from '@/lib/toast-manager';
import { closeAll, useToastQueue } from '@/lib/toast/toast-queue';
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
    articleId: 'all-in-1',
    title: 'These are the guests today',
    publicationName: 'All In',
    countryCode: 'DEU',
    languageCode: 'de',
};

function Card() {
    const toast = useToast();
    toastManager.setToastInstance(toast);
    const rowActions = React.useMemo(() => ({ answered: null, saved: false, onToggleSave: () => {}, onShare: () => {} }), []);
    const menu = useArticleMenu({ subject: SUBJECT, publisherId: 'pub-all-in', rowActions: rowActions as never });
    return (
        <>
            <Pressable testID="open-menu" onPress={() => menu.open()} />
            {menu.element}
        </>
    );
}

const press = async (id: string) => {
    await waitFor(() => expect(screen.getByTestId(id)).toBeTruthy());
    await act(async () => {
        fireEvent.press(screen.getByTestId(id));
    });
};

beforeAll(async () => {
    await initI18nEn();
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
}, 60_000);
beforeEach(() => {
    __clearPublisherSourceNames();
    closeAll();
    rememberPublisherSourceNames('pub-all-in', ['All In']);
});
afterEach(closeAll);

const toasts = () => useToastQueue.getState().entries.length;

it('writes and shows the toast straight from the menu', async () => {
    await render(<Card />);
    await press('open-menu');
    await press('menu-source');
    await press('menu-not-preferred-source');
    await waitFor(() => expect(toasts()).toBe(1), { timeout: 3000 });
    expect(await getPreferenceKind('All In')).toBe('mute');
}, 15000);

it('writes and shows the toast after a visit to the feedback tree', async () => {
    await render(<Card />);
    await press('open-menu');
    await press('menu-whats-wrong');
    await waitFor(() => expect(screen.getByTestId('feedback-tell-mera')).toBeTruthy());
    await press('sheet-back');
    await press('menu-source');
    await press('menu-not-preferred-source');
    await waitFor(() => expect(toasts()).toBe(1), { timeout: 3000 });
    expect(await getPreferenceKind('All In')).toBe('mute');
}, 15000);
