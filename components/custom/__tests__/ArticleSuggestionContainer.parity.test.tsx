/* eslint-disable @typescript-eslint/no-require-imports */
import { render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/custom/ArticleMetaRow', () => ({ ArticleMetaRow: () => null }));
jest.mock('@/components/custom/news-detail/ExtractedMetadataPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/GlassSurface', () => ({ GlassPanel: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
const mockTitle = jest.fn((_p: any) => null);
jest.mock('@/components/custom/TranslatableDynamic', () => ({ __esModule: true, default: (p: any) => mockTitle(p) }));
jest.mock('@/components/custom/chat/StreamingIndicator', () => ({ __esModule: true, default: () => null }));
const mockReasonNote = jest.fn((_p: any) => null);
jest.mock('@/components/custom/cards/ReasonNote', () => ({
    ...jest.requireActual('@/components/custom/cards/ReasonNote'),
    __esModule: true,
    default: (p: any) => mockReasonNote(p),
}));
const mockFactChips = jest.fn((_p: any) => null);
jest.mock('@/components/custom/cards/FactChips', () => ({ __esModule: true, default: (p: any) => mockFactChips(p) }));
jest.mock('@/lib/database/services/fact-service', () => ({ getFactsForTopicTexts: jest.fn(async () => []) }));
jest.mock('@/components/custom/SmoothScrollView', () => {
    const ReactLib = require('react');
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: ReactLib.forwardRef(({ parallaxHeader, children }: any, _ref: any) =>
            ReactLib.createElement(View, null, parallaxHeader, children),
        ),
    };
});
jest.mock('@/components/ui/image', () => {
    const { View } = require('react-native');
    return { Image: (p: any) => <View {...p} /> };
});
jest.mock('@/lib/stores/blur-images-store', () => ({
    useBlurImagesStore: (sel: (s: { blurImages: boolean }) => unknown) => sel({ blurImages: false }),
}));

import { ArticleSuggestionContainer } from '../ArticleSuggestionContainer';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';

const row = (o: Record<string, unknown> = {}) =>
    ({
        _id: 's1',
        articleId: 'a1',
        relevance: 0.6,
        reason: '',
        status: ArticleSuggestionStatus.ReasonPending,
        title_en: 'T',
        image_url: null,
        userTopicIds: ['berlin housing'],
        createdAt: new Date().toISOString(),
        ...o,
    }) as any;

const lastNote = () => mockReasonNote.mock.calls[mockReasonNote.mock.calls.length - 1]?.[0];

beforeEach(() => {
    mockReasonNote.mockClear();
    mockFactChips.mockClear();
});

// The detail screen must show what the Feed card shows for the same row: the
// same pending rule (notePendingMode over the in-flight set, never a timer),
// the same fact chips and the same hero rendition.
describe('ArticleSuggestionContainer detail matches the Feed card', () => {
    it('in flight: "writing", readable (the screen has no card root to speak it)', () => {
        render(<ArticleSuggestionContainer suggestion={row()} variant="screen" reasonWriting />);
        expect(lastNote()).toMatchObject({ pendingMode: 'writing', reason: '' });
        expect(lastNote().pendingSpokenByHost).toBeFalsy();
    });

    it('nothing in flight, however long ago it was scored: "not-yet", never a give-up line', () => {
        render(
            <ArticleSuggestionContainer
                suggestion={row({ scoredAt: Date.now() - 3_600_000 })}
                variant="screen"
                reasonWriting={false}
            />,
        );
        expect(lastNote()).toMatchObject({ pendingMode: 'not-yet' });
    });

    it('a declined note (reason_skipped) still shows the box, like the card', () => {
        render(<ArticleSuggestionContainer suggestion={row({ status: ArticleSuggestionStatus.ReasonSkipped })} variant="screen" />);
        expect(lastNote()).toMatchObject({ pendingMode: 'not-yet' });
    });

    it('complete with no note: the same fact chips as the card', () => {
        render(<ArticleSuggestionContainer suggestion={row({ status: ArticleSuggestionStatus.Complete })} variant="screen" />);
        expect(mockFactChips).toHaveBeenCalledWith({ topicIds: ['berlin housing'] });
        expect(mockReasonNote).not.toHaveBeenCalled();
    });

    it('the hero asks for the same upgraded rendition as the card', () => {
        const { getByTestId } = render(
            <ArticleSuggestionContainer
                suggestion={row({ image_url: 'https://www.alphatv.gr/wp-content/uploads/2026/09/photo-300x200.jpg' })}
                variant="screen"
            />,
        );
        expect(getByTestId('detail-hero-image').props.source).toEqual({
            uri: 'https://www.alphatv.gr/wp-content/uploads/2026/09/photo.jpg',
        });
    });

    it('a missing title falls back to the same translated label as the card', () => {
        render(<ArticleSuggestionContainer suggestion={row({ title_en: null })} variant="screen" />);
        expect(mockTitle).toHaveBeenCalledWith(expect.objectContaining({ as: 'heading', text: 'feed.newsCluster' }));
    });
});
