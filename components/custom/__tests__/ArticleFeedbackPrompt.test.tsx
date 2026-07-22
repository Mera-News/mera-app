// ArticleFeedbackPrompt — "i" labels-toggle behavior. When ON each button
// renders its label as a caption; the choice persists via setting-service.
/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('@/components/custom/MeraLogo', () => { const { View } = require('react-native'); return { __esModule: true, default: (p: any) => <View {...p} /> }; });
jest.mock('@/components/custom/feedback-tree/FeedbackTreeOverlay', () => ({ __esModule: true, default: () => null }));

jest.mock('@/lib/database/services/article-feedback-service', () => ({
    hasLiked: jest.fn(() => Promise.resolve(false)),
    recordArticleFeedback: jest.fn(() => Promise.resolve()),
    removeArticleFeedback: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/database/services/publication-visit-service', () => ({
    getVisitCountForPublication: jest.fn(() => Promise.resolve(0)),
}));

const mockGetSetting = jest.fn((..._a: unknown[]) => Promise.resolve<string | null>(null));
const mockSetSetting = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (...args: unknown[]) => mockGetSetting(...args),
    setSetting: (...args: unknown[]) => mockSetSetting(...args),
}));

jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn(), hapticSuccess: jest.fn() }));
jest.mock('@/lib/hooks/useShareArticle', () => ({ useShareArticle: () => jest.fn() }));
jest.mock('@/lib/tracking/use-tracked-subject', () => ({ useTrackedSubject: () => ({ tracked: false, toggle: jest.fn() }) }));
jest.mock('@/lib/stores/floating-chat-store', () => ({ useFloatingChatStore: { getState: () => ({ expand: jest.fn() }) } }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

import { ArticleFeedbackPrompt } from '../ArticleFeedbackPrompt';

const baseProps = { articleId: 'a1', title: 'Test title' };

describe('ArticleFeedbackPrompt — labels toggle', () => {
    beforeEach(() => {
        mockGetSetting.mockClear().mockResolvedValue(null);
        mockSetSetting.mockClear();
    });

    it('hides captions by default (labels off)', async () => {
        const { queryByText } = render(<ArticleFeedbackPrompt {...baseProps} />);
        await waitFor(() => expect(mockGetSetting).toHaveBeenCalledWith('action_labels_enabled'));
        expect(queryByText('articleFeedback.likeLabel')).toBeNull();
        expect(queryByText('articleFeedback.dislikeLabel')).toBeNull();
    });

    it('shows captions and persists when the "i" toggle is pressed', async () => {
        const { getByText, getByLabelText, queryByText } = render(
            <ArticleFeedbackPrompt {...baseProps} />,
        );
        await waitFor(() => expect(mockGetSetting).toHaveBeenCalled());
        expect(queryByText('articleFeedback.likeLabel')).toBeNull();

        fireEvent.press(getByLabelText('articleFeedback.toggleLabels'));

        expect(getByText('articleFeedback.likeLabel')).toBeTruthy();
        expect(getByText('articleFeedback.dislikeLabel')).toBeTruthy();
        expect(mockSetSetting).toHaveBeenCalledWith('action_labels_enabled', '1');
    });

    it('hydrates captions on mount when the setting is on', async () => {
        mockGetSetting.mockResolvedValue('1');
        const { findByText } = render(<ArticleFeedbackPrompt {...baseProps} />);
        expect(await findByText('articleFeedback.likeLabel')).toBeTruthy();
    });
});
