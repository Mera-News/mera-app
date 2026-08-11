// FeedbackTreeOverlay against the REAL bundled tree — the second surface.
//
// Two surfaces render this server-owned tree and they have drifted before. The
// v5 restructure puts three specific things at risk on THIS one, none of which
// the overlay's fixture-driven suites can see:
//
//   • `findNode('not_important')`. The overlay's entry screen is a one-tap fast
//     path resolved by a hard-coded LEAF ID. The restructure moved that leaf;
//     had it also renamed it, the entry screen would silently render nothing
//     above "Tell me more" and no test built on a local fixture would notice.
//   • the LABEL BAG. "Show less of {{entity}}" needs `entity` passed to `t()`
//     here as well as in InlineFeedbackTree. A missing var renders braces on
//     one surface only — invisible from the other.
//   • the `manage_publication` NUDGE. The overlay handles nudges itself (it has
//     no host callback for them), so it needs its own branch; without one this
//     leaf would fall through to the generic "look for related coverage" toast.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
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
jest.mock('@/components/ui/toast', () => ({
  useToast: () => ({ show: jest.fn() }),
  Toast: ({ children }: any) => children,
  ToastTitle: ({ children }: any) => children,
  ToastDescription: ({ children }: any) => children,
}));
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
jest.mock('@/lib/stores/subscription-store', () => ({ getAiAccess: () => 'unlocked' }));

const mockApplyLeafActions = jest.fn(async () => 1);
jest.mock('@/components/custom/feedback-tree/apply-leaf-actions', () => ({
  applyLeafActions: (...a: any[]) => mockApplyLeafActions(...(a as [])),
}));

jest.mock('@/lib/services/feedback-tree-service', () => ({
  getFeedbackTree: jest.fn(
    async () => require('@/lib/services/feedback-tree-snapshot').BUNDLED_FEEDBACK_TREE,
  ),
  refreshFeedbackTree: jest.fn(async () => {}),
}));

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import React from 'react';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import FeedbackTreeOverlay from '../FeedbackTreeOverlay';

function setup(context: LocalFeedbackContext, onLeafPicked = jest.fn()) {
  const onClose = jest.fn();
  const utils = render(
    <FeedbackTreeOverlay
      visible
      onClose={onClose}
      root="dislike"
      onLeafPicked={onLeafPicked}
      context={{ articleTitle: 'A story', ...context }}
      chatContext={{ kind: 'article-suggestion', articleId: 'a1', articleTitle: 'A story' } as any}
      chatMessage="hi"
    />,
  );
  return { ...utils, onClose, onLeafPicked };
}

const TAGGED: LocalFeedbackContext = {
  matchedTopics: [{ topicId: 't1', text: 'cricket' }],
  eventType: 'election',
  entity: 'Reserve Bank of India',
  geoText: 'Mumbai',
  placeValue: 'Mumbai',
  publicationName: 'The Hindu',
};

beforeEach(() => jest.clearAllMocks());

describe('FeedbackTreeOverlay — the shipped v5 tree', () => {
  it('still resolves its `not_important` fast path after the restructure', async () => {
    // The entry screen renders exactly one chip above "Tell me more", found by
    // id. If the restructure had renamed the leaf, this row would be absent and
    // the overlay would open on a bare button.
    const { getByText } = setup(TAGGED);
    expect(await waitFor(() => getByText('Not that important'))).toBeTruthy();
    expect(getByText('Tell me more')).toBeTruthy();
  });

  it('applies that fast path in one tap', async () => {
    const { getByText, onLeafPicked } = setup(TAGGED);
    fireEvent.press(await waitFor(() => getByText('Not that important')));
    await waitFor(() => expect(onLeafPicked).toHaveBeenCalled());
    expect(onLeafPicked).toHaveBeenCalledWith(['not_important'], 1, true);
  });

  it('names the article`s tags in its labels too — same bag as the inline surface', async () => {
    const utils = setup(TAGGED);
    fireEvent.press(await waitFor(() => utils.getByText('Tell me more')));
    fireEvent.press(await waitFor(() => utils.getByText('Not a good suggestion')));

    expect(await waitFor(() => utils.getByText('Show less of election'))).toBeTruthy();
    expect(utils.getByText('Show less of Reserve Bank of India')).toBeTruthy();
    expect(utils.getByText('Show less of Mumbai')).toBeTruthy();
    expect(utils.queryByText(/\{\{/)).toBeNull();
  });

  it('opens the publication-preferences screen for the manage_publication nudge', async () => {
    const utils = setup(TAGGED);
    fireEvent.press(await waitFor(() => utils.getByText('Tell me more')));
    fireEvent.press(await waitFor(() => utils.getByText('Issue with this publication')));
    fireEvent.press(await waitFor(() => utils.getByText('Manage publications')));

    expect(router.push).toHaveBeenCalledWith('/logged-in/publication-preferences');
    expect(mockApplyLeafActions).not.toHaveBeenCalled();
    // A nudge commits the verdict with zero applied actions, like browse_related.
    expect(utils.onLeafPicked).toHaveBeenCalledWith(
      ['publication_issue', 'manage_publication'],
      0,
      true,
    );
    expect(utils.onClose).toHaveBeenCalled();
  });

  it('hides the tag leaves on an untagged article', async () => {
    const utils = setup({ matchedTopics: [{ topicId: 't1', text: 'cricket' }] });
    fireEvent.press(await waitFor(() => utils.getByText('Tell me more')));
    fireEvent.press(await waitFor(() => utils.getByText('Not a good suggestion')));
    await waitFor(() => expect(utils.getByText('Not that important')).toBeTruthy());
    expect(utils.queryByText(/^Show less of/)).toBeNull();
  });
});
