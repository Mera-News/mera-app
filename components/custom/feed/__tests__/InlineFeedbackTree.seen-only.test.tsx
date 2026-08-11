// InlineFeedbackTree — the seenOnly leaf ("I've seen this already").
//
// It changes nothing by design. Two failure modes bracket it: staying SILENT
// reads as a broken button one tap after the panel promised "your feed changes
// right away"; COMMITTING would fill the thumb, which promises "this changed
// your persona" — also false. So it acknowledges out loud and does not commit.
//
// Setup mirrors InlineFeedbackTree.apply.test.tsx (same mocked tree + apply
// path); kept separate so that suite's assertions stay untouched.
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
  // Pure helpers the tree uses for the place label + the `place` filter's
  // verbatim value. Null here: these fixtures carry no geo tags, so the place
  // leaf stays hidden.
  placeValueFromTags: jest.fn(() => null),
  geoTextFromTags: jest.fn(() => null),
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
const mockAcknowledge = jest.fn(async () => {});
jest.mock('@/components/custom/feedback-tree/acknowledge-seen-only', () => ({
  acknowledgeSeenOnly: () => mockAcknowledge(),
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

function renderTree(handlers: {
  onTreePathChanged?: jest.Mock;
  onLeafCommitted?: jest.Mock;
}) {
  return render(
    <InlineFeedbackTree
      suggestion={makeSuggestion()}
      verdict="dislike"
      onTreePathChanged={handlers.onTreePathChanged ?? jest.fn()}
      onInvokeMera={jest.fn()}
      onLeafCommitted={handlers.onLeafCommitted ?? jest.fn()}
    />,
  );
}

beforeEach(() => jest.clearAllMocks());


describe("InlineFeedbackTree — I've seen this already", () => {
  beforeEach(() => jest.clearAllMocks());

  it('acknowledges out loud instead of failing silently', async () => {
    const { getByText } = renderTree({});
    fireEvent.press(await waitFor(() => getByText("I've seen this already")));
    expect(mockAcknowledge).toHaveBeenCalledTimes(1);
  });

  it('does NOT commit — a filled thumb would promise a persona change it never made', async () => {
    const onLeafCommitted = jest.fn();
    const { getByText } = renderTree({ onLeafCommitted });
    fireEvent.press(await waitFor(() => getByText("I've seen this already")));
    expect(onLeafCommitted).not.toHaveBeenCalled();
    expect(mockApplyLeafActions).not.toHaveBeenCalled();
  });

  it('still records where the user got to', async () => {
    const onTreePathChanged = jest.fn();
    const { getByText } = renderTree({ onTreePathChanged });
    fireEvent.press(await waitFor(() => getByText("I've seen this already")));
    expect(onTreePathChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      ['seen_already'],
    );
  });

  it('a leaf that DOES change something still commits', async () => {
    const onLeafCommitted = jest.fn();
    const { getByText } = renderTree({ onLeafCommitted });
    fireEvent.press(await waitFor(() => getByText('Not that important')));
    expect(onLeafCommitted).toHaveBeenCalledTimes(1);
  });
});
