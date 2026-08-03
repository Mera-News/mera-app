// InlineFeedbackTree — the rebuilt "It's paywalled" branch.
//
// Deliberately drives the REAL bundled tree rather than a local fixture: the
// defect being fixed was not in the engine (which behaved correctly) but in the
// tree CONTENT — two gated, informational children, so the branch gated itself
// out of existence and the one option that did render closed the panel and did
// nothing. A synthetic fixture would have passed throughout. These tests fail if
// either the content or the wiring regresses.
//
// The apply path is mocked at `apply-leaf-actions` for the same reason as the
// sibling apply suite: the real one dynamically imports the persona executor and
// the feedback service, dragging the native DB singleton in.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Mirrors real i18next's {{var}} interpolation against `defaultValue`. The
    // four paywall keys DO exist in en.json, but this mock never resolves a real
    // key, so every case here goes through `defaultValue` — which is exactly the
    // string the bundled tree carries, and which must match en.json verbatim.
    t: (key: string, opts?: Record<string, unknown>) => {
      const base = (opts && (opts.defaultValue as string)) || key;
      if (!opts) return base;
      return base.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) =>
        String(opts[name] ?? ''),
      );
    },
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
// 7 visits — past the `publication_visits_gte: 5` gate on the block option.
jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getVisitCountForPublication: jest.fn(async () => 7),
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  getSuggestionFeedbackContext: jest.fn(async () => ({ category: 'Politics' })),
}));

const mockApplyLeafActions = jest.fn(async () => 1);
jest.mock('@/components/custom/feedback-tree/apply-leaf-actions', () => ({
  applyLeafActions: (...a: any[]) => mockApplyLeafActions(...(a as [])),
}));

// The SHIPPED tree — see the file header.
jest.mock('@/lib/services/feedback-tree-service', () => ({
  getFeedbackTree: jest.fn(
    async () => require('@/lib/services/feedback-tree-snapshot').BUNDLED_FEEDBACK_TREE,
  ),
  refreshFeedbackTree: jest.fn(async () => {}),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import InlineFeedbackTree from '../InlineFeedbackTree';

const RELATED_DESC =
  'A similar story from another publication may not be paywalled — check the related articles.';
const BLOCK_DESC =
  "You've visited The Hindu 7 times this month — consider subscribing for full access.";

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
    eventType: null,
    headlineScope: null,
    matchedTopics: [{ topicId: 't1', text: 'cricket' }],
  };
}

function renderTree(overrides?: {
  onTreePathChanged?: jest.Mock;
  onLeafCommitted?: jest.Mock;
  onNudge?: jest.Mock;
}) {
  const handlers = {
    onTreePathChanged: overrides?.onTreePathChanged ?? jest.fn(),
    onInvokeMera: jest.fn(),
    onLeafCommitted: overrides?.onLeafCommitted ?? jest.fn(),
    onNudge: overrides?.onNudge ?? jest.fn(),
  };
  const utils = render(
    <InlineFeedbackTree suggestion={makeSuggestion()} verdict="dislike" {...handlers} />,
  );
  return { ...utils, ...handlers };
}

/** Root → "Problem with the site" → "It's paywalled". */
async function openPaywall(utils: ReturnType<typeof renderTree>) {
  fireEvent.press(await waitFor(() => utils.getByText('Problem with the site')));
  fireEvent.press(await waitFor(() => utils.getByText("It's paywalled")));
}

beforeEach(() => jest.clearAllMocks());

describe('InlineFeedbackTree — the paywall branch', () => {
  it('is reachable at all: "It\'s paywalled" renders as a real branch, not a hidden dead end', async () => {
    const utils = renderTree();
    fireEvent.press(await waitFor(() => utils.getByText('Problem with the site')));
    // The regression: both old children were gated, so the whole row vanished.
    expect(await waitFor(() => utils.getByText("It's paywalled"))).toBeTruthy();
  });

  it('renders each option with its own message, interpolating publication + visits', async () => {
    const utils = renderTree();
    await openPaywall(utils);

    expect(await waitFor(() => utils.getByText('Show related coverage'))).toBeTruthy();
    expect(utils.getByText(RELATED_DESC)).toBeTruthy();

    // The block option appears once the async visit lookup lands (7 ≥ 5), with
    // BOTH placeholders filled — in the chip label and in the message.
    expect(await waitFor(() => utils.getByText('Block The Hindu instead'))).toBeTruthy();
    expect(utils.getByText(BLOCK_DESC)).toBeTruthy();
    // Braces must never survive to the screen.
    expect(utils.queryByText(/\{\{/)).toBeNull();
  });

  it('browse_related commits the path, hands the nudge to the host, and mutates NOTHING', async () => {
    const utils = renderTree();
    await openPaywall(utils);
    fireEvent.press(await waitFor(() => utils.getByText('Show related coverage')));

    const path = ['publication_website', 'paywall', 'paywall_related'];
    expect(utils.onTreePathChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      path,
    );
    // It IS a real answer — the verdict commits — but it is a suggestion, not a
    // persona mutation, so nothing is applied.
    expect(utils.onLeafCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      path,
    );
    expect(utils.onNudge).toHaveBeenCalledWith('browse_related');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApplyLeafActions).not.toHaveBeenCalled();
  });

  it('the block option ARMS on the first tap and only mutes on the second', async () => {
    const utils = renderTree();
    await openPaywall(utils);
    const chip = await waitFor(() => utils.getByText('Block The Hindu instead'));

    // First tap — armed, nothing applied, nothing committed. The message is
    // withdrawn too: it described the un-armed option, which is now off screen.
    fireEvent.press(chip);
    expect(await waitFor(() => utils.getByText('Tap again to confirm'))).toBeTruthy();
    expect(utils.queryByText(BLOCK_DESC)).toBeNull();
    expect(mockApplyLeafActions).not.toHaveBeenCalled();
    expect(utils.onLeafCommitted).not.toHaveBeenCalled();

    // Second tap — mutes.
    fireEvent.press(utils.getByText('Tap again to confirm'));
    await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
    const [actions, , spend] = mockApplyLeafActions.mock.calls[0] as unknown as [
      unknown[],
      string,
      { articleId: string; sentiment: string },
    ];
    expect(actions).toEqual([
      expect.objectContaining({ publicationId: 'The Hindu', publicationPref: 'mute' }),
    ]);
    expect(spend).toEqual({ articleId: 'art-1', sentiment: 'dislike' });
    expect(utils.onLeafCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      ['publication_website', 'paywall', 'paywall_block_source'],
    );
    // Muting is a persona mutation, not a nudge.
    expect(utils.onNudge).not.toHaveBeenCalled();
  });
});
