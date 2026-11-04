// The read block for an article with no usable language (MERA-APP-99).
import { render, screen } from '@testing-library/react-native';
import React from 'react';
import ReadTranslateActions from '@/components/custom/news-detail/ReadTranslateActions';
import { initI18nEn } from '@/test/helpers';

jest.mock('@/components/custom/news-detail/AboutTranslationModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/VideoPlayerModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/stores/app-language-store', () => ({ useAppLanguage: () => 'en' }));
jest.mock('@/lib/stores/publication-display-store', () => ({ useDisplayPublication: (name: string) => name }));

const mount = async (sourceLanguage: string | null) =>
    await render(
        <ReadTranslateActions
            articleUrl="https://example.com/story"
            sourceLanguage={sourceLanguage}
            publicationName="Example News"
            onOpenUrl={jest.fn()}
        />,
    );

const LEAVES_APP = 'Read on Google Translate, opens outside Mera';

beforeAll(initI18nEn);

describe('ReadTranslateActions', () => {
    it('keeps Google Translate for an unknown language and says it leaves the app', async () => {
        await mount(null);
        expect(screen.getByTestId('detail-read-google-translate').props.accessibilityLabel).toBe(LEAVES_APP);
    });

    it('names no source language in an unknown state', async () => {
        await mount(null);
        const spoken = ['detail-read-publisher', 'detail-how-to-translate', 'detail-read-google-translate', 'detail-about-translation']
            .map((id) => screen.getByTestId(id).props.accessibilityLabel as string)
            .join(' ');
        expect(spoken).not.toMatch(/\b(Dutch|English|language)\b/i);
    });

    it('still hides the route for an article in the reader\'s own language', async () => {
        await mount('en');
        expect(screen.queryByTestId('detail-read-google-translate')).toBeNull();
    });
});
