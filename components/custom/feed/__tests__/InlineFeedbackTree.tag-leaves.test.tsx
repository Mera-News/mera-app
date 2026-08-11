// InlineFeedbackTree — the v5 tag leaves and the manage-publications nudge, on
// the REAL bundled tree.
//
// Same rationale as the paywall suite: what is being tested is the JOIN between
// server-owned tree CONTENT and the app's rendering, and a synthetic fixture
// passes no matter what the shipped tree says. Two joins in particular are
// invisible from anywhere else:
//
//   • the LABEL. "Show less of {{entity}}" only renders as a sentence if this
//     surface passes `entity` to `t()`. It does not throw when it doesn't — it
//     renders the braces, on this surface only, while the modal overlay looks
//     fine. That asymmetry is why `feedbackLabelVars` is shared and why this
//     asserts the rendered STRING rather than the props.
//   • the CONTEXT. `entity` and `placeValue` are derived from the suggestion
//     row here; if that derivation is dropped the leaves simply stop appearing,
//     which reads exactly like the intended "hide when untagged" behaviour.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Mirrors real i18next {{var}} interpolation against `defaultValue`.
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
jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getVisitCountForPublication: jest.fn(async () => 0),
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  // The module is mocked because it drags the native DB singleton in; this is
  // the same city → region → countryCode walk the real `placeValueFromTags`
  // does. That the REAL one agrees with `geoTextFromTags` and survives the trip
  // into the scorer's matcher is pinned separately, by
  // lib/news-harness/feedback-tree/__tests__/tag-leaf-round-trip.test.ts.
  placeValueFromTags: (tags: { city?: string; region?: string; countryCode?: string }[]) => {
    for (const t of tags ?? []) {
      const v = t?.city?.trim() || t?.region?.trim() || t?.countryCode?.trim();
      if (v) return v;
    }
    return null;
  },
  // Same walk, then the supranational code rendered as prose — this is the
  // asymmetry the two helpers exist to express.
  geoTextFromTags: (tags: { city?: string; region?: string; countryCode?: string }[]) => {
    for (const t of tags ?? []) {
      const v = t?.city?.trim() || t?.region?.trim();
      if (v) return v;
      const c = t?.countryCode?.trim();
      if (c) return c === 'MIDDLE_EAST' ? 'Middle East' : c;
    }
    return null;
  },
  getSuggestionFeedbackContext: jest.fn(async () => mockRowContext()),
}));
// The LOCAL row's contribution. Overridden per-test to prove the row is the
// authoritative source — some ForYouSuggestion projections (a saved card) carry
// neither `entities` nor `geoTags`.
let mockRowContext: () => Record<string, unknown> = () => ({ category: 'Politics' });

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
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import InlineFeedbackTree from '../InlineFeedbackTree';

function makeSuggestion(over: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
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
    ...over,
  };
}

function renderTree(suggestion: ForYouSuggestion, onNudge = jest.fn()) {
  const handlers = {
    onTreePathChanged: jest.fn(),
    onInvokeMera: jest.fn(),
    onLeafCommitted: jest.fn(),
    onNudge,
  };
  const utils = render(
    <InlineFeedbackTree suggestion={suggestion} verdict="dislike" {...handlers} />,
  );
  return { ...utils, ...handlers };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRowContext = () => ({ category: 'Politics' });
});

describe('InlineFeedbackTree — v5 tag leaves name the article`s own tags', () => {
  const tagged = () =>
    makeSuggestion({
      eventType: 'election',
      entities: ['Reserve Bank of India', 'Nifty 50'],
      geoTags: [{ city: 'Mumbai', countryCode: 'IN' }],
    });

  it('renders the tag VALUE in each label, not the raw placeholder', async () => {
    const utils = renderTree(tagged());
    fireEvent.press(await waitFor(() => utils.getByText('Not a good suggestion')));

    expect(await waitFor(() => utils.getByText('Show less of election'))).toBeTruthy();
    // The PRIMARY entity — the server emits entities most-central-first.
    expect(utils.getByText('Show less of Reserve Bank of India')).toBeTruthy();
    // …and the PROSE place, while the filter itself carries the tag verbatim.
    expect(utils.getByText('Show less of Mumbai')).toBeTruthy();
    // The failure mode this exists for: an unsupplied var renders its braces.
    expect(utils.queryByText(/\{\{/)).toBeNull();
  });

  it('mints the structured filter the label promised', async () => {
    const utils = renderTree(tagged());
    fireEvent.press(await waitFor(() => utils.getByText('Not a good suggestion')));
    fireEvent.press(await waitFor(() => utils.getByText('Show less of Reserve Bank of India')));

    await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
    const [actions, label] = mockApplyLeafActions.mock.calls[0] as unknown as [any[], string];
    expect(actions).toEqual([
      {
        action_type: 'add_suppression',
        suppressionPattern: 'Reserve Bank of India',
        suppressionStrength: 0.5,
        suppressionKind: 'entity',
        suppressionValue: 'Reserve Bank of India',
      },
    ]);
    // The Undo toast quotes the same named label the chip showed.
    expect(label).toBe('Show less of Reserve Bank of India');
  });

  it('carries the VERBATIM tag into the place filter, not the display prose', async () => {
    const utils = renderTree(
      makeSuggestion({ geoTags: [{ countryCode: 'MIDDLE_EAST' }] }),
    );
    fireEvent.press(await waitFor(() => utils.getByText('Not a good suggestion')));
    // Label reads as prose…
    fireEvent.press(await waitFor(() => utils.getByText('Show less of Middle East')));

    await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
    const [actions] = mockApplyLeafActions.mock.calls[0] as unknown as [any[]];
    // …the filter carries the code. Compared code-to-code downstream, so the
    // prose form would have matched nothing, ever.
    expect(actions[0]).toMatchObject({
      suppressionKind: 'place',
      suppressionValue: 'MIDDLE_EAST',
    });
  });

  it('reads the tags off the local ROW when the suggestion projection has none', async () => {
    // The saved-card projection (saved-article-suggestion-service) has no
    // `entities` / `geoTags` column at all. Sourcing only from the suggestion
    // would hide both leaves there — silently, and indistinguishably from the
    // intended "hide when untagged".
    mockRowContext = () => ({
      category: 'Politics',
      entities: ['Reserve Bank of India'],
      geoText: 'Middle East',
      placeValue: 'MIDDLE_EAST',
    });
    const utils = renderTree(makeSuggestion({ eventType: 'election' }));
    fireEvent.press(await waitFor(() => utils.getByText('Not a good suggestion')));

    expect(
      await waitFor(() => utils.getByText('Show less of Reserve Bank of India')),
    ).toBeTruthy();
    expect(utils.getByText('Show less of Middle East')).toBeTruthy();

    fireEvent.press(utils.getByText('Show less of Middle East'));
    await waitFor(() => expect(mockApplyLeafActions).toHaveBeenCalledTimes(1));
    const [actions] = mockApplyLeafActions.mock.calls[0] as unknown as [any[]];
    expect(actions[0]).toMatchObject({ suppressionKind: 'place', suppressionValue: 'MIDDLE_EAST' });
  });

  it('hides each leaf on an untagged article instead of showing a dead chip', async () => {
    const utils = renderTree(makeSuggestion());
    fireEvent.press(await waitFor(() => utils.getByText('Not a good suggestion')));
    await waitFor(() => expect(utils.getByText('Not that important')).toBeTruthy());
    expect(utils.queryByText(/^Show less of/)).toBeNull();
  });
});

describe('InlineFeedbackTree — the manage-publications nudge', () => {
  it('opens the publication-preferences screen and mutates nothing', async () => {
    const onNudge = jest.fn();
    const utils = renderTree(makeSuggestion(), onNudge);
    fireEvent.press(await waitFor(() => utils.getByText('Issue with this publication')));
    fireEvent.press(await waitFor(() => utils.getByText('Manage publications')));

    // Its MESSAGE renders too — the first non-paywall node to carry one, and
    // the only new copy on this surface.
    expect(
      utils.getByText('Boost, downrank or mute any publication — including this one.'),
    ).toBeTruthy();
    expect(router.push).toHaveBeenCalledWith('/logged-in/publication-preferences');
    // A nudge is a host intent, never a persona mutation.
    expect(mockApplyLeafActions).not.toHaveBeenCalled();
    // The host still hears about it (all hosts ignore what they don't handle).
    expect(onNudge).toHaveBeenCalledWith('manage_publication');
    // …and the verdict commits, exactly like browse_related.
    expect(utils.onLeafCommitted).toHaveBeenCalledWith(
      expect.anything(),
      'dislike',
      ['publication_issue', 'manage_publication'],
    );
  });
});
