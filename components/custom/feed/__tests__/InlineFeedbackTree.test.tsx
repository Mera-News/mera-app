// InlineFeedbackTree tests — the Feed-tab inline tree. UI primitives are stubbed
// to plain RN views (cards.test.tsx pattern); the tree service + DB lookups are
// mocked so the tree renders without native deps.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Mirrors real i18next's {{var}} interpolation against `defaultValue` (the
    // new keys this suite exercises aren't in en.json yet — see the calling
    // task's constraints — so every case here resolves via defaultValue).
    // NOT a faithful stand-in for real i18next: this mock never resolves an
    // actual key, and real i18next ALSO does plural-suffix key resolution
    // (`_one`/`_other`) whenever a `count` var is present, tried before the
    // base key — which is exactly why production code here uses `extra`,
    // not `count`, for the "+N more" var (see InlineFeedbackTree.tsx).
    t: (key: string, opts?: Record<string, unknown>) => {
      const base = (opts && (opts.defaultValue as string)) || key;
      if (!opts) return base;
      return base.replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) =>
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
  getSuggestionFeedbackContext: jest.fn(async () => ({ category: null })),
}));

const TREE = {
  version: 2,
  root: [
    {
      id: 'suggestion',
      labelKey: 'k.sug',
      labelDefault: 'Not a good suggestion',
      children: [
        { id: 'wrong_topic', labelKey: 'k.wt', labelDefault: 'Wrong topic', leaf: { actions: [] } },
        { id: 'something_else', labelKey: 'k.se', labelDefault: 'Something else', leaf: { openChat: true } },
      ],
    },
    {
      // HISTORICAL shape — this is what the production "paywall" node looked
      // like when the dead-branch rule was written: a raw non-empty `children`
      // array whose only child is gated on `cluster_size_gte`, a condition
      // InlineFeedbackTree's local context never supplies (buildLocalContext
      // never sets `clusterSize`). Production has since rebuilt that branch
      // around an UNGATED first child, so it is no longer dead — but the ENGINE
      // behaviour this fixture exercises is still exactly right and still worth
      // pinning, so the fixture stays as a synthetic dead branch.
      id: 'gated_branch',
      labelKey: 'k.gb',
      labelDefault: 'Gated branch',
      children: [
        {
          id: 'gated_leaf',
          labelKey: 'k.gl',
          labelDefault: 'Gated leaf',
          visibleIf: { cluster_size_gte: 2 },
          leaf: {},
        },
      ],
    },
  ],
  likeRoot: [
    {
      id: 'more_topic',
      labelKey: 'k.mt',
      labelDefault: 'More about this topic',
      children: [
        { id: 'a_lot_more', labelKey: 'k.alm', labelDefault: 'A lot more', leaf: { actions: [] } },
      ],
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
    eventType: null,
    headlineScope: null,
    matchedTopics: [{ topicId: 't1', text: 'cricket' }],
  };
}

describe('InlineFeedbackTree', () => {
  it('descending a branch records the path and reveals its children', async () => {
    const onTreePathChanged = jest.fn();
    const onInvokeMera = jest.fn();
    const onLeafCommitted = jest.fn();
    const { getByText } = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        onTreePathChanged={onTreePathChanged}
        onInvokeMera={onInvokeMera}
        onLeafCommitted={onLeafCommitted}
      />,
    );

    const branch = await waitFor(() => getByText('Not a good suggestion'));
    fireEvent.press(branch);

    expect(onTreePathChanged).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      ['suggestion'],
    );
    // Children now visible.
    await waitFor(() => getByText('Wrong topic'));
    expect(onInvokeMera).not.toHaveBeenCalled();
    // A branch is not a terminal leaf — no auto-advance signal.
    expect(onLeafCommitted).not.toHaveBeenCalled();
  });

  it('tapping an openChat leaf escalates to Mera with the full path (no auto-advance)', async () => {
    const onTreePathChanged = jest.fn();
    const onInvokeMera = jest.fn();
    const onLeafCommitted = jest.fn();
    const { getByText } = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        onTreePathChanged={onTreePathChanged}
        onInvokeMera={onInvokeMera}
        onLeafCommitted={onLeafCommitted}
      />,
    );

    fireEvent.press(await waitFor(() => getByText('Not a good suggestion')));
    fireEvent.press(await waitFor(() => getByText('Something else')));

    expect(onInvokeMera).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      ['suggestion', 'something_else'],
    );
    // openChat leaves hand off to Mera — they must NOT auto-advance the deck.
    expect(onLeafCommitted).not.toHaveBeenCalled();
  });

  it('tapping a terminal actions leaf records the path + fires onLeafCommitted (auto-advance)', async () => {
    const onTreePathChanged = jest.fn();
    const onInvokeMera = jest.fn();
    const onLeafCommitted = jest.fn();
    const { getByText } = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        onTreePathChanged={onTreePathChanged}
        onInvokeMera={onInvokeMera}
        onLeafCommitted={onLeafCommitted}
      />,
    );

    fireEvent.press(await waitFor(() => getByText('Not a good suggestion')));
    fireEvent.press(await waitFor(() => getByText('Wrong topic')));

    expect(onInvokeMera).not.toHaveBeenCalled();
    expect(onTreePathChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      ['suggestion', 'wrong_topic'],
    );
    expect(onLeafCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ articleId: 'art-1' }),
      'dislike',
      ['suggestion', 'wrong_topic'],
    );
  });

  it('HIDES a branch whose only child is gated out (no dead-end row at all)', async () => {
    const { getByText, queryByText, UNSAFE_queryAllByProps } = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        onTreePathChanged={jest.fn()}
        onInvokeMera={jest.fn()}
        onLeafCommitted={jest.fn()}
      />,
    );

    await waitFor(() => getByText('Not a good suggestion'));
    // not-interested P4i — conscious reversal: 'Gated branch' used to render
    // chevron-less but still tappable. QA found that shape in the wild as the
    // 'It's paywalled' row, which closed the panel and applied nothing. A
    // branch with no visible children is now hidden outright.
    expect(queryByText('Gated branch')).toBeNull();

    // `gated_branch` has a raw `children` array (length 1), but its only
    // child is gated on cluster_size_gte — which this context never
    // satisfies. Only the REAL branch ('suggestion') gets a chevron; the
    // gated one must not, or tapping it would descend into an empty panel.
    // The mocked MaterialIcons (a bare prop-spreading View) matches once as
    // the composite fiber and once more for each RN View wrapper layer in
    // between — filter to the host "View" string-type fiber so this counts
    // rendered chevrons, not incidental fiber depth.
    const chevrons = UNSAFE_queryAllByProps({ name: 'arrow-forward-ios' }).filter(
      (node) => typeof node.type === 'string',
    );
    expect(chevrons).toHaveLength(1);
  });

  it('breadcrumb root renders the parent panel title, not a generic "All"', async () => {
    const dislike = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        onTreePathChanged={jest.fn()}
        onInvokeMera={jest.fn()}
        onLeafCommitted={jest.fn()}
      />,
    );
    fireEvent.press(await waitFor(() => dislike.getByText('Not a good suggestion')));
    expect(await waitFor(() => dislike.getByText('Less like this'))).toBeTruthy();
    expect(dislike.queryByText('All')).toBeNull();

    const like = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="like"
        onTreePathChanged={jest.fn()}
        onInvokeMera={jest.fn()}
        onLeafCommitted={jest.fn()}
      />,
    );
    fireEvent.press(await waitFor(() => like.getByText('More about this topic')));
    expect(await waitFor(() => like.getByText('More like this'))).toBeTruthy();
    expect(like.queryByText('All')).toBeNull();
  });

  it('an explicit rootLabel overrides the verdict-derived default (CardFeedbackSurface passes its own heading)', async () => {
    const { getByText, queryByText } = render(
      <InlineFeedbackTree
        suggestion={makeSuggestion()}
        verdict="dislike"
        rootLabel="Custom Heading"
        onTreePathChanged={jest.fn()}
        onInvokeMera={jest.fn()}
        onLeafCommitted={jest.fn()}
      />,
    );
    fireEvent.press(await waitFor(() => getByText('Not a good suggestion')));
    expect(await waitFor(() => getByText('Custom Heading'))).toBeTruthy();
    expect(queryByText('Less like this')).toBeNull();
  });

  // "More about this topic" (production id `more_about_topic`) never named
  // WHICH topic it means — its "A lot more" / "A bit more" leaves asked the
  // user to weight an unnamed thing. `label()` interpolates the matched topic
  // into this specific node's chip AND breadcrumb crumb.
  describe('naming the matched topic on "more_about_topic"', () => {
    const TREE_WITH_NAMED_NODE = {
      version: 2,
      root: [],
      likeRoot: [
        {
          id: 'more_about_topic',
          labelKey: 'feedback.more_about_topic',
          labelDefault: 'More about this topic',
          children: [
            { id: 'a_lot_more', labelKey: 'k.alm', labelDefault: 'A lot more', leaf: { actions: [] } },
          ],
        },
      ],
    };

    beforeEach(() => {
      jest
        .requireMock('@/lib/services/feedback-tree-service')
        .getFeedbackTree.mockResolvedValue(TREE_WITH_NAMED_NODE);
    });

    afterEach(() => {
      jest.requireMock('@/lib/services/feedback-tree-service').getFeedbackTree.mockResolvedValue(TREE);
    });

    it('names a single real matched topic in the chip', async () => {
      const suggestion = {
        ...makeSuggestion(),
        matchedTopics: [{ topicId: 't1', text: 'Formula 1' }],
      };
      const { getByText, queryByText } = render(
        <InlineFeedbackTree
          suggestion={suggestion}
          verdict="like"
          onTreePathChanged={jest.fn()}
          onInvokeMera={jest.fn()}
          onLeafCommitted={jest.fn()}
        />,
      );
      expect(await waitFor(() => getByText('More about: Formula 1'))).toBeTruthy();
      expect(queryByText('More about this topic')).toBeNull();
    });

    it('picks the first real topic and says how many more when there are several', async () => {
      const suggestion = {
        ...makeSuggestion(),
        matchedTopics: [
          { topicId: null, text: 'Synthetic headline' }, // ignored — no topicId
          { topicId: 't1', text: 'Formula 1' },
          { topicId: 't2', text: 'Motorsport' },
        ],
      };
      const { getByText } = render(
        <InlineFeedbackTree
          suggestion={suggestion}
          verdict="like"
          onTreePathChanged={jest.fn()}
          onInvokeMera={jest.fn()}
          onLeafCommitted={jest.fn()}
        />,
      );
      expect(await waitFor(() => getByText('More about: Formula 1 and 1 more'))).toBeTruthy();
    });

    it('falls back to the generic label when there are no real matched topics (never renders an empty "More about: ")', async () => {
      const suggestion = {
        ...makeSuggestion(),
        matchedTopics: [{ topicId: null, text: 'Synthetic headline' }],
      };
      const { getByText, queryByText } = render(
        <InlineFeedbackTree
          suggestion={suggestion}
          verdict="like"
          onTreePathChanged={jest.fn()}
          onInvokeMera={jest.fn()}
          onLeafCommitted={jest.fn()}
        />,
      );
      expect(await waitFor(() => getByText('More about this topic'))).toBeTruthy();
      // The generic (non-interpolated) label never colon-suffixes a topic.
      expect(queryByText(/^More about: /)).toBeNull();
    });

    it('names the topic in the breadcrumb crumb after descending', async () => {
      const suggestion = {
        ...makeSuggestion(),
        matchedTopics: [{ topicId: 't1', text: 'Formula 1' }],
      };
      const { getByText, queryByText } = render(
        <InlineFeedbackTree
          suggestion={suggestion}
          verdict="like"
          onTreePathChanged={jest.fn()}
          onInvokeMera={jest.fn()}
          onLeafCommitted={jest.fn()}
        />,
      );
      fireEvent.press(await waitFor(() => getByText('More about: Formula 1')));
      // Post-descent: the chip list advanced to "A lot more" (the chip is
      // gone), and the named text — rendered by the SAME `label()` callback —
      // now shows up as the breadcrumb crumb instead of the generic
      // "More about this topic".
      expect(await waitFor(() => getByText('A lot more'))).toBeTruthy();
      expect(getByText('More about: Formula 1')).toBeTruthy(); // now the crumb
      expect(queryByText('More about this topic')).toBeNull();
    });
  });
});
