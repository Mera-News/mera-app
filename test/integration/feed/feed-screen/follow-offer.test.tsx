// A reader whose Feed is empty never reaches the inbox, so the same hygiene card sits in the Feed's
// empty state (FeedShortcuts) while an offer waits. The real card, hook, services and in-memory DB.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import FeedShortcuts from '@/components/custom/feed/FeedShortcuts';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { addFollowInsteadProposal, getPendingProposals } from '@/lib/database/services/hygiene-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { getActiveForTopicReconcile } from '@/lib/database/services/tracked-story-service';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import i18n from '@/lib/i18n';
import {
  detectFollowInstead,
  followInsteadProposal,
  type FollowInsteadRow,
} from '@/lib/news-harness/persona-management/fact-hygiene';
import { toastManager } from '@/lib/toast-manager';
import * as tracking from '@/lib/tracking/track-actions';
import { initI18nEn } from '@/test/helpers';

jest.mock('expo-router', () => ({ router: { push: jest.fn(), navigate: jest.fn() }, useIsFocused: () => true }));
jest.mock('@/lib/explore/world-pages', () => ({ useWorldPages: () => ({ pages: [] }) }));

const BLANK = { origin: 'article', surface: 'follow-instead', articleId: '', title: '' } as const;

const unread = (topicId: string, n: number): FollowInsteadRow[] =>
  Array.from({ length: n }, (_, i) => ({
    storyKey: `${topicId}-${i}`,
    topicIds: [topicId],
    opened: false,
    alreadyRead: false,
    judged: true,
    passedGate: false,
  }));

/** The offer the sweep would publish for a no-stake fact, or a flood on a second topic. */
async function pendingOffer(trigger: 'no_stake' | 'flood') {
  const fact = await addFact('Follows football', undefined, { attribute: 'topics' });
  const topics = await createTopics(
    ['premier league', 'quiet one', 'quiet two', 'quiet three'].map((text) => ({ text, factId: fact.id, weight: 1, status: 'active', provenance: 'llm' })),
  );
  const snapshot = topics.map((t) => ({
    id: t.id,
    factId: fact.id,
    text: t.text,
    normalizedText: t.normalizedText,
    weight: 1,
    status: 'active' as const,
    lastSignalAtMs: null,
  }));
  const rows =
    trigger === 'no_stake'
      ? unread(topics[0].id, 25)
      : [...unread(topics[0].id, 40), ...topics.slice(1).flatMap((t) => unread(t.id, 2).map((r) => ({ ...r, passedGate: true })))];
  const facts = [{ id: fact.id, statement: fact.statement, questionnaireAttribute: 'topics', isInterest: trigger === 'no_stake', newsStopped: false }];
  const [candidate] = detectFollowInstead({ facts, topics: snapshot, rows });
  await addFollowInsteadProposal(followInsteadProposal(candidate, { label: 'Football', searchText: 'football' }, BLANK));
  const [offer] = await getPendingProposals();
  return offer;
}

const confirmDialog = async () => {
  await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
  const [dialog] = useDialogQueue.getState().queue;
  await act(async () => settleDialog(dialog.id, true));
  return dialog;
};

let syncNow: jest.SpyInstance;
let success: jest.SpyInstance;

beforeEach(async () => {
  await initI18nEn();
  useDialogQueue.setState({ queue: [] });
  syncNow = jest.spyOn(tracking, 'syncFollowedStoryNow').mockResolvedValue();
  success = jest.spyOn(toastManager, 'showSuccess').mockImplementation(() => undefined as never);
});
afterEach(() => {
  syncNow.mockRestore();
  success.mockRestore();
});

it('shows nothing extra with no offer waiting', async () => {
  await render(<FeedShortcuts reading={false} />);

  expect(await screen.findByTestId('feed-shortcuts')).toBeTruthy();
  expect(screen.queryByText(i18n.t('hygiene.titleFollowInstead'))).toBeNull();
});

it('words a no-stake offer, and accepting takes the fact and fills Followed stories', async () => {
  const offer = await pendingOffer('no_stake');
  await render(<FeedShortcuts reading={false} />);

  expect(await screen.findByText(i18n.t('hygiene.titleFollowInstead'))).toBeTruthy();
  expect(screen.getByText(i18n.t('hygiene.summary.followInsteadNoStake', { topic: 'Football' }))).toBeTruthy();
  expect(screen.getByText(i18n.t('hygiene.effectFollowInstead'))).toBeTruthy();
  expect(screen.getByText(i18n.t('hygiene.keepFact'))).toBeTruthy();

  fireEvent.press(screen.getByTestId(`hygiene-accept-${offer.id}`));
  const dialog = await confirmDialog();

  expect(dialog.body).toBe(i18n.t('hygiene.followInsteadFactGoes', { fact: 'Follows football', topic: 'Football' }));
  expect(dialog.destructive).toBe(true);
  await waitFor(async () => expect(await getActiveForTopicReconcile()).toHaveLength(1));
  await waitFor(async () => expect(await getFacts()).toEqual([]));
  await waitFor(() => expect(success).toHaveBeenCalledWith(i18n.t('hygiene.followInsteadDoneTitle', { topic: 'Football' }), i18n.t('hygiene.followInsteadDoneBody')));
  expect(syncNow).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByText(i18n.t('hygiene.titleFollowInstead'))).toBeNull());
});

it('words a flood, and its dialog says the fact stays', async () => {
  const offer = await pendingOffer('flood');
  await render(<FeedShortcuts reading={false} />);

  expect(await screen.findByText(i18n.t('hygiene.summary.followInsteadFlood', { topic: 'Football' }))).toBeTruthy();

  fireEvent.press(screen.getByTestId(`hygiene-accept-${offer.id}`));
  const dialog = await confirmDialog();

  expect(dialog.body).toBe(i18n.t('hygiene.followInsteadTopicMoves', { topic: 'Football' }));
  expect(dialog.destructive).toBeFalsy();
  await waitFor(async () => expect(await getActiveForTopicReconcile()).toHaveLength(1));
  expect(await getFacts()).toHaveLength(1);
});

it('Keep it as a fact is one tap: no dialog, the fact stays, and it does not come back', async () => {
  const offer = await pendingOffer('no_stake');
  await render(<FeedShortcuts reading={false} />);

  fireEvent.press(await screen.findByTestId(`hygiene-reject-${offer.id}`));

  await waitFor(() => expect(screen.queryByText(i18n.t('hygiene.titleFollowInstead'))).toBeNull());
  expect(useDialogQueue.getState().queue).toEqual([]);
  expect(await getFacts()).toHaveLength(1);
  expect(await getActiveForTopicReconcile()).toEqual([]);
  expect(await getPendingProposals()).toEqual([]);
});

it('cancelling the dialog changes nothing', async () => {
  const offer = await pendingOffer('no_stake');
  await render(<FeedShortcuts reading={false} />);

  fireEvent.press(await screen.findByTestId(`hygiene-accept-${offer.id}`));
  await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
  await act(async () => settleDialog(useDialogQueue.getState().queue[0].id, false));

  expect(await getFacts()).toHaveLength(1);
  expect((await getPendingProposals()).map((p) => p.id)).toEqual([offer.id]);
  expect(screen.getByText(i18n.t('hygiene.titleFollowInstead'))).toBeTruthy();
});
