// TriageActionBar — each verdict button drives the triage store's resolve, which
// fires the feedback / persona / impression / save side effects. We render the
// REAL store (its resolve is the unit under test here) with all DB-service,
// pipeline, router and native-UI seams mocked, seed a current card, press each
// button, and assert the right services fired.
/* eslint-disable @typescript-eslint/no-require-imports */

// ── Service seams the store's resolve calls ──
const mockRecordArticleFeedback = jest.fn((..._a: any[]) => Promise.resolve());
jest.mock('@/lib/database/services/article-feedback-service', () => ({
    recordArticleFeedback: (...a: any[]) => mockRecordArticleFeedback(...a),
}));
const mockSaveSuggestion = jest.fn((..._a: any[]) => Promise.resolve());
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
    saveSuggestion: (...a: any[]) => mockSaveSuggestion(...a),
}));
const mockApplyPersonaAction = jest.fn((..._a: any[]) => Promise.resolve({ applied: true, summary: '' }));
jest.mock('@/lib/database/services/persona-action-executor', () => ({
    applyPersonaAction: (...a: any[]) => mockApplyPersonaAction(...a),
}));
const mockRecordOpen = jest.fn((..._a: any[]) => Promise.resolve());
jest.mock('@/lib/database/services/story-impression-service', () => ({
    recordOpen: (...a: any[]) => mockRecordOpen(...a),
    recordImpression: jest.fn(() => Promise.resolve()),
    getOpenedSeenSet: jest.fn(() => Promise.resolve(new Set())),
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    loadSuggestions: jest.fn(() => Promise.resolve([])),
    getSuggestionByServerId: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('@/lib/database/services/publication-visit-service', () => ({
    getVisitCountForPublication: jest.fn(() => Promise.resolve(0)),
}));
jest.mock('@/lib/services/scoring-pipeline', () => ({
    registerChunkReleaseListener: jest.fn(() => () => {}),
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/lib/haptics', () => ({
    hapticLight: jest.fn(),
    hapticMedium: jest.fn(),
    hapticSuccess: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn() },
}));

// ── UI primitive seams → plain RN views (jest-expo can't render gluestack). ──
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/feedback-tree/FeedbackTreeOverlay', () => ({
    __esModule: true,
    default: () => null,
}));

// eslint-disable-next-line import/first
import { fireEvent, render } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import React from 'react';
// eslint-disable-next-line import/first
import TriageActionBar from '../TriageActionBar';
// eslint-disable-next-line import/first
import { useTriageStore } from '@/lib/stores/triage-store';
// eslint-disable-next-line import/first
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
// eslint-disable-next-line import/first
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';

function makeSuggestion(overrides: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
    return {
        _id: 's1',
        articleId: 'a1',
        clusters: [],
        relevance: 0.8,
        reason: '',
        status: ArticleSuggestionStatus.Complete,
        country_code: 'US',
        language_code: 'en',
        publication_name: 'Test Pub',
        title_en: 'A headline',
        title_original: 'A headline',
        description_en: '',
        article_url: 'https://example.com/1',
        image_url: null,
        userTopicIds: [],
        createdAt: new Date().toISOString(),
        firstPubDate: new Date().toISOString(),
        rawScore: 0.8,
        eventType: null,
        headlineScope: null,
        matchedTopics: [{ topicId: 't1', text: 'topic' }],
        ...overrides,
    };
}

function seedCurrent(s: ForYouSuggestion) {
    useTriageStore.setState({
        deck: [{ id: s._id, bucket: 'HIGH', rawScore: 0.8, pubDateMs: 0, state: 'current' }],
        suggestionsById: new Map([[s._id, s]]),
        currentIndex: 0,
        handledIds: new Set<string>(),
        initialized: true,
        status: 'active',
    });
}

beforeEach(() => jest.clearAllMocks());

describe('TriageActionBar', () => {
    it('Good → records a like + nudges the matched topic + recordOpen', () => {
        const s = makeSuggestion();
        seedCurrent(s);
        const { getByLabelText } = render(<TriageActionBar suggestion={s} />);
        fireEvent.press(getByLabelText('triage.good'));
        expect(mockRecordArticleFeedback).toHaveBeenCalledWith(
            expect.objectContaining({ sentiment: 'like', origin: 'suggestion', surface: 'triage' }),
        );
        expect(mockApplyPersonaAction).toHaveBeenCalledWith(
            expect.objectContaining({ action_type: 'set_topic_weight', topicId: 't1', delta: 0.04 }),
            'feedback',
        );
        expect(mockRecordOpen).toHaveBeenCalled();
    });

    it('Bad → records a dislike + negative nudge + recordOpen', () => {
        const s = makeSuggestion();
        seedCurrent(s);
        const { getByLabelText } = render(<TriageActionBar suggestion={s} />);
        fireEvent.press(getByLabelText('triage.bad'));
        expect(mockRecordArticleFeedback).toHaveBeenCalledWith(
            expect.objectContaining({ sentiment: 'dislike', surface: 'triage' }),
        );
        expect(mockApplyPersonaAction).toHaveBeenCalledWith(
            expect.objectContaining({ topicId: 't1', delta: -0.06 }),
            'feedback',
        );
    });

    it('Save → saveSuggestion + recordOpen', () => {
        const s = makeSuggestion();
        seedCurrent(s);
        const { getByLabelText } = render(<TriageActionBar suggestion={s} />);
        fireEvent.press(getByLabelText('triage.save'));
        expect(mockSaveSuggestion).toHaveBeenCalledWith(expect.objectContaining({ _id: 's1' }));
        expect(mockRecordOpen).toHaveBeenCalled();
    });

    it('Read → recordOpen + router push', () => {
        const s = makeSuggestion();
        seedCurrent(s);
        const { getByLabelText } = render(<TriageActionBar suggestion={s} />);
        fireEvent.press(getByLabelText('triage.read'));
        const { router } = require('expo-router');
        expect(mockRecordOpen).toHaveBeenCalled();
        expect(router.push).toHaveBeenCalledWith(
            expect.objectContaining({ pathname: '/logged-in/suggestion-detail' }),
        );
    });

    it('Skip → fires no feedback / open / save side effects', () => {
        const s = makeSuggestion();
        seedCurrent(s);
        const { getByLabelText } = render(<TriageActionBar suggestion={s} />);
        fireEvent.press(getByLabelText('triage.skip'));
        expect(mockRecordArticleFeedback).not.toHaveBeenCalled();
        expect(mockRecordOpen).not.toHaveBeenCalled();
        expect(mockSaveSuggestion).not.toHaveBeenCalled();
        expect(mockApplyPersonaAction).not.toHaveBeenCalled();
    });
});
