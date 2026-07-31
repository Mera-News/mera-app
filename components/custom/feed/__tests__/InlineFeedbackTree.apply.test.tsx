// InlineFeedbackTree — D16: a terminal leaf APPLIES its persona actions.
//
// Kept in its own file (rather than appended to InlineFeedbackTree.test.tsx)
// because it needs a tree whose leaves carry real actions plus mocks for the
// apply path; the sibling suite deliberately exercises inert leaves and its
// mocks stay untouched.
//
// The apply path is mocked at `apply-leaf-actions` — the real one dynamically
// imports the persona executor, the feedback service and (via the undo
// affordance) `revertChange`, which since Phase 3 runs the retroactive
// suppression sweeps and would drag the native DB singleton into this suite.
// It also owns the "stamp the verdict row spent" step, which is why the
// assertions below check the `spend` argument rather than the DB call.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts && (opts.defaultValue as string)) || key,
  }),
}));
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
jest.mock('@/lib/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
  hapticSuccess: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getVisitCountForPublication: jest.fn(async () => 0),
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getSuggestionFeedbackContext: jest.fn(async () => ({
    category: 'Politics',
    clusterSize: 4,
    geoText: 'mumbai',
  })),
}));

const mockApplyLeafActions = jest.fn(async () => 1);
jest.mock('@/components/custom/feedback-tree/apply-leaf-actions', () => ({
  applyLeafActions: (...a: any[]) => mockApplyLeafActions(...(a as [])),
}));

const TREE = {
  version: 2,
  root: [
    {
      id: 'not_important',
      labelKey: 'k.ni',
      labelDefault: 'Not that important',
      leaf: { actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.15 }] },
    },
    {
      id: 'seen_already',
      labelKey: 'k.sa',
      labelDefault: "I've seen this already",
      leaf: { seenOnly: true },
    },
  ],
  likeRoot: [
    {
      id: 'more_from_publication',
      labelKey: 'k.mfp',
      labelDefault: 'More from this publication',
      leaf: { actions: [{ type: 'set_publication_pref', value: 'boost' }] },
    },
  ],
};
jest.mock('@/lib/services/feedback-tree-service', () => ({
  getFeedbackTree: jest.fn(async () => TREE),
  refreshFeedbackTree: jest.fn(async () => {}),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import InlineFeedbackTree from '../InlineFeedbackTree';

function makeSuggestion(): ForYouSuggestion {
  return {
    _id: 'sugg-1',
    articleId: 'art-1',
    clusters: [],
    relevance: 0.8,
    reason: '',
    status: 'complete' as ForYouSuggestion['status'],
    country_code: 'IN',
    language_code: 'en',
    publication_name: 'The Hindu',
    title_en: 'A story',
    title_original: null,
    description_en: null,
    article_url: null,
    image_url: null,
    userTopicIds: [],
    createdAt: '2026-07-20',
    firstPubDate: '2026-07-19',
    rawScore: null,
    eventType: 'election',
    headlineScope: null,
    matchedTopics: [{ topicId: 't1', text: 'cricket' }],
  };
}

function renderTree(verdict: 'like' | 'dislike') {
  return render(
    <InlineFeedbackTree
      suggestion={makeSuggestion()}
      verdict={verdict}
      onTreePathChanged={jest.fn()}
      onInvokeMera={jest.fn()}
      onLeafCommitted={jest.fn()}
    />,
  );
}

beforeEach(() => jest.clearAllMocks());

describe('InlineFeedbackTree — terminal leaves apply (D16)', () => {
  it('resolves a dislike leaf to persona actions, applies them, and stamps the signal spent', async () => {
    const { getByText } = renderTree('dislike');
    fireEvent.press(await waitFor(() => getByText('Not that important')));

    await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
    const [actions, summary, spend] = mockApplyLeafActions.mock.calls[0] as unknown as [
      unknown[],
      string,
      { articleId: string; sentiment: string },
    ];
    expect(actions).toEqual([
      expect.objectContaining({ topicId: 't1', delta: -0.15 }),
    ]);
    expect(summary).toBe('Not that important');
    // Applied on the spot ⇒ the row is handed over to be stamped spent, so the
    // digest can never apply a second helping of the same signal.
    expect(spend).toEqual({ articleId: 'art-1', sentiment: 'dislike' });
  });

  it('runs the LIKE tree too — the side that had never executed a single leaf', async () => {
    const { getByText } = renderTree('like');
    fireEvent.press(await waitFor(() => getByText('More from this publication')));

    await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
    const [actions, , spend] = mockApplyLeafActions.mock.calls[0] as unknown as [
      unknown[],
      string,
      { articleId: string; sentiment: string },
    ];
    expect(actions).toEqual([
      expect.objectContaining({ publicationId: 'The Hindu', publicationPref: 'boost' }),
    ]);
    expect(spend).toEqual({ articleId: 'art-1', sentiment: 'like' });
  });

  it('applies nothing — and stamps nothing — for a leaf that carries no actions', async () => {
    const { getByText } = renderTree('dislike');
    fireEvent.press(await waitFor(() => getByText("I've seen this already")));

    await new Promise((r) => setTimeout(r, 0));
    expect(mockApplyLeafActions).not.toHaveBeenCalled();
  });
});
