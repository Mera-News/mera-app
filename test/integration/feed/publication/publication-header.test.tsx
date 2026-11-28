// PublicationHeader's phone reading score line: the link, its spoken label, the URL it opens, and the
// measurements that keep the buttons below from moving. Faked: only the in-app browser.
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import PublicationHeader from '@/components/custom/publication-page/PublicationHeader';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { TextScaleContext } from '@/lib/typography/TextScaleContext';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { initI18nEn } from '@/test/helpers';

jest.mock('@/lib/web-browser-utils', () => ({
    ...jest.requireActual('@/lib/web-browser-utils'),
    openInAppBrowser: jest.fn(() => Promise.resolve()),
}));

const ID = '0123456789abcdef01234567';
const flat = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

const header = (props: Partial<React.ComponentProps<typeof PublicationHeader>> = {}) => (
    <PublicationHeader
        displayName="Harbour Daily"
        homepageUrl="https://harbour.example/"
        details="India"
        readingScore={92}
        reportPublisherId={ID}
        scoreReserved
        {...props}
    />
);

beforeAll(initI18nEn);
// The RN jest preset's window reports fontScale 2: every test starts at the OS default, 1.
const originalWindow = Dimensions.get('window');
const setOsFontScale = (fontScale: number) =>
    Dimensions.set({ window: { ...originalWindow, fontScale }, screen: Dimensions.get('screen') });
beforeEach(() => setOsFontScale(1));
afterAll(() => setOsFontScale(originalWindow.fontScale));
beforeEach(() => {
    (openInAppBrowser as jest.Mock).mockClear();
    useAppLanguageStore.setState({ appLanguage: 'en' });
});

describe('the score line', () => {
    it('is a link with a spoken label and hint, and shows the score', async () => {
        const { getByTestId, getByText } = await render(header());
        const link = getByTestId('publication-reading-score');
        expect(link.props.accessibilityRole).toBe('link');
        expect(link.props.accessibilityLabel).toBe('Phone reading score 92 out of 100');
        expect(link.props.accessibilityHint).toBe('Opens the report on mera.news, in English.');
        expect(getByText('Phone reading score 92/100', { includeHiddenElements: true })).toBeTruthy();
    });

    it('opens the report in the app language', async () => {
        const first = await render(header());
        await fireEvent.press(first.getByTestId('publication-reading-score'));
        expect(openInAppBrowser).toHaveBeenLastCalledWith(`https://mera.news/en/publications/${ID}`);
        await first.unmount();
        useAppLanguageStore.setState({ appLanguage: 'hi' });
        const second = await render(header());
        await fireEvent.press(second.getByTestId('publication-reading-score'));
        expect(openInAppBrowser).toHaveBeenLastCalledWith(`https://mera.news/hi/publications/${ID}`);
    });

    it('without a score the slot still holds its height and there is no link', async () => {
        const { getByTestId, queryByTestId } = await render(header({ readingScore: null }));
        const slot = flat(getByTestId('publication-score-slot'));
        expect(slot.minHeight).toBe(18);
        expect(slot.marginTop).toBe(6);
        expect(queryByTestId('publication-reading-score')).toBeNull();
    });

    it('reserved or not, the host link and the score target keep their measurements', async () => {
        const off = await render(header({ scoreReserved: false }));
        expect(off.queryByTestId('publication-score-slot')).toBeNull();
        expect(flat(off.getByTestId('publication-website-frame')).marginBottom).toBe(-13);
        await off.unmount();
        const on = await render(header());
        const host = flat(on.getByTestId('publication-website-frame'));
        expect(host.marginBottom).toBe(-5);
        expect(host.minHeight).toBe(36);
        expect(flat(on.getByTestId('publication-score-frame'))).toMatchObject({
            marginTop: -5,
            paddingTop: 5,
            marginBottom: -21,
            paddingBottom: 21,
        });
    });

    it('the reserved height follows the text size', async () => {
        const { getByTestId } = await render(<TextScaleContext.Provider value={1.5}>{header()}</TextScaleContext.Provider>);
        expect(flat(getByTestId('publication-score-slot')).minHeight).toBe(27);
    });

    describe('with a large OS text size', () => {
        it('reserves the line React Native will draw, capped at the ui Text cap (2x)', async () => {
            setOsFontScale(1.5);
            const first = await render(header());
            expect(flat(first.getByTestId('publication-score-slot')).minHeight).toBe(27);
            first.unmount();
            setOsFontScale(3.1);
            const capped = await render(header());
            expect(flat(capped.getByTestId('publication-score-slot')).minHeight).toBe(36);
        });
    });
});
