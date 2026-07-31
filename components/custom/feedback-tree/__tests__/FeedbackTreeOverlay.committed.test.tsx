// FeedbackTreeOverlay — `onLeafPicked` carries `committed` EXPLICITLY.
//
// The overlay is the only place that knows WHY a leaf applied nothing. Its hosts
// (ArticleActionsRow, CompactActionsSheet) previously inferred commitment from
// `appliedCount === 0`, which cannot separate "changes nothing by design"
// (seenOnly) from "placeholders wouldn't resolve" — so "I've seen this already"
// wrote `committed: true`, filled the thumb, and contradicted the inline tree
// for the very same leaf on the very same article.
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
jest.mock('@/components/ui/toast', () => {
  const { View } = require('react-native');
  return {
    Toast: (p: any) => <View {...p} />,
    ToastTitle: (p: any) => <View {...p} />,
    ToastDescription: (p: any) => <View {...p} />,
    useToast: () => ({ show: jest.fn(), close: jest.fn(), closeAll: jest.fn(), isActive: () => false }),
  };
});
// RN's Modal pulls an untransformed ESM native-component spec into jest; the
// overlay's behaviour has nothing to do with the host view, so render children
// straight through.
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: (props: any) => (props.visible === false ? null : props.children),
}));
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
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: { getState: () => ({ openArticleFeedback: jest.fn() }) },
}));

const mockApplyLeafActions = jest.fn(async () => 2);
jest.mock('@/components/custom/feedback-tree/apply-leaf-actions', () => ({
  applyLeafActions: (...a: any[]) => mockApplyLeafActions(...(a as [])),
}));

const TREE = {
  version: 2,
  root: [
    {
      id: 'seen_already',
      labelKey: 'k.sa',
      labelDefault: "I've seen this already",
      leaf: { seenOnly: true },
    },
    {
      id: 'not_important',
      labelKey: 'k.ni',
      labelDefault: 'Not that important',
      leaf: { actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.15 }] },
    },
    {
      id: 'nudge_browse_related',
      labelKey: 'k.nb',
      labelDefault: 'Browse related',
      leaf: { nudge: 'browse_related' },
    },
  ],
  likeRoot: [],
};
jest.mock('@/lib/services/feedback-tree-service', () => ({
  getFeedbackTree: jest.fn(async () => TREE),
  refreshFeedbackTree: jest.fn(async () => {}),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import FeedbackTreeOverlay from '../FeedbackTreeOverlay';

/** The overlay opens on a curated ENTRY screen (one fast-path leaf + "Tell me
 *  more"); the full root list is behind that button. */
async function openFullTree(utils: ReturnType<typeof render>) {
  fireEvent.press(await waitFor(() => utils.getByText('Tell me more')));
  return utils;
}

function setup(onLeafPicked: jest.Mock) {
  return render(
    <FeedbackTreeOverlay
      visible
      onClose={jest.fn()}
      root="dislike"
      onLeafPicked={onLeafPicked}
      context={{ articleTitle: 'A story', matchedTopics: [{ topicId: 't1', text: 'cricket' }] }}
      chatContext={{ kind: 'article-suggestion', articleId: 'a1', articleTitle: 'A story' } as any}
      chatMessage="hi"
    />,
  );
}

beforeEach(() => jest.clearAllMocks());

describe('FeedbackTreeOverlay — the committed flag', () => {
  it('reports committed=false for a seenOnly leaf', async () => {
    const onLeafPicked = jest.fn();
    const { getByText } = await openFullTree(setup(onLeafPicked));
    fireEvent.press(await waitFor(() => getByText("I've seen this already")));

    expect(onLeafPicked).toHaveBeenCalledWith(['seen_already'], 0, false);
  });

  it('reports committed=true for a leaf that actually applies', async () => {
    const onLeafPicked = jest.fn();
    const { getByText } = setup(onLeafPicked);
    fireEvent.press(await waitFor(() => getByText('Not that important')));

    await waitFor(() => expect(onLeafPicked).toHaveBeenCalled());
    expect(onLeafPicked).toHaveBeenCalledWith(['not_important'], 2, true);
  });

  it('a nudge reports appliedCount 0 but STILL commits — it is a reason the user gave', async () => {
    const onLeafPicked = jest.fn();
    const { getByText } = await openFullTree(setup(onLeafPicked));
    fireEvent.press(await waitFor(() => getByText('Browse related')));

    // Proves `committed` is not simply `appliedCount > 0` — the two differ here.
    expect(onLeafPicked).toHaveBeenCalledWith(['nudge_browse_related'], 0, true);
  });
});
