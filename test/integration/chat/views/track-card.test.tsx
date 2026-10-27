// chatfix P2 U4: the follow-a-story card, rendered for real over the committed actions. Cards are
// staged exactly as the agent stages them (decideProposeTrack + a persisted assistant row) and
// re-derived from the store the way the thread does, so every tap lands in the real override.
// Fakes: the feed sync, the accessibility bridge, the engine's More options answer.
// Copy for the new keys is not in the dictionaries yet (the locale splice lands later), so the
// test registers a bundle whose every string is its own key; assertions read keys.
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, PixelRatio, StyleSheet } from 'react-native';
import { growTrackCard } from '@/components/custom/floating-chat/track-card-actions';
import TrackStoryCard from '@/components/custom/floating-chat/TrackStoryCard';
import { deriveThreadItems } from '@/components/custom/floating-chat/deriveThreadItems';
import type { TrackCardSource } from '@/components/custom/floating-chat/types';
import { appendMessage, createConversation, fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { observeActive } from '@/lib/database/services/tracked-story-service';
import i18n from '@/lib/i18n';
import type { ProposalAction } from '@/lib/llm/types';
import { decideProposeTrack } from '@/lib/news-harness/article-feedback/agent-core';
import { makeFollowStorySubject } from '@/lib/news-harness/follow-story';
import * as chatSession from '@/lib/chat-session/chat-session';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import * as trackActions from '@/lib/tracking/track-actions';
import { initI18nEn } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { firstValueFrom } from 'rxjs';
import '@/test/helpers';

let seq = 0;
const subject = makeFollowStorySubject();
const action = (label: string): Extract<ProposalAction, { type: 'track_story' }> => ({ type: 'track_story', label, searchText: label.toLowerCase(), subject });

const PLAIN = [
  'cardTitle', 'moreOptions', 'moreOptionsLoading', 'moreOptionsNone', 'moreOptionsFailed', 'follow', 'tryAgain',
  'rowFollowing', 'rowAlready', 'rowFailed', 'followFailedAll', 'optionsExpired',
];
const PLURAL = ['moreOptionsAdded', 'followTicked', 'followingAll', 'followingSome'];
function registerCopy() {
  const trackedStories: Record<string, string> = {};
  for (const k of PLAIN) trackedStories[k] = `trackedStories.${k}`;
  for (const k of PLURAL) for (const s of ['one', 'other']) trackedStories[`${k}_${s}`] = `trackedStories.${k}_${s}:${k === 'followingSome' ? '{{done}}/{{count}}' : '{{count}}'}`;
  i18n.addResourceBundle('en', 'translation', { trackedStories }, true, true);
}
const key = (k: string) => `trackedStories.${k}`;
const cancelText = () => i18n.t('articleFeedback.proposalCancel');

async function stage(labels: string[]) {
  const staged = decideProposeTrack({ options: labels.map((l) => ({ label: l, search: l.toLowerCase() })) }, subject);
  const proposal = staged.sideEffects!.proposal!;
  useFloatingChatStore.getState().setProposal(proposal);
  const tc = { id: 'tc-0', name: 'proposeTrack', status: 'done' as const, input: {}, result: staged.result };
  const msgId = `asst-track-view-${++seq}`;
  const conversationId = await createConversation('CONFIG');
  await appendMessage(conversationId, { role: 'assistant', content: 'Pick below.', toolCalls: [tc] }, msgId);
  return { proposal, conversationId, msgId, baseResult: staged.result };
}

/** The card as the thread draws it: re-derived from the persisted row plus the live overrides. */
function Thread({ history, superseded = false, onGrown }: { history: Awaited<ReturnType<typeof fetchMessagesForConversation>>; superseded?: boolean; onGrown?: () => void }) {
  const results = useFloatingChatStore((s) => s.toolCallResults);
  const items = deriveThreadItems({ live: [], history, introMessage: null, isStreaming: false, earlierConversationLabel: 'Earlier', toolCallResults: results });
  const c = items.find((i) => i.kind === 'proposal-card') as Extract<(typeof items)[number], { kind: 'proposal-card' }>;
  const track: TrackCardSource = { ...c.track!, superseded: superseded || c.track!.superseded };
  return <TrackStoryCard proposal={c.proposal} source={track} onGrown={onGrown} />;
}

async function mount(labels: string[], opts: { superseded?: boolean; onGrown?: () => void } = {}) {
  // The agent stages at most four options; more arrive through More options.
  const staged = await stage(labels.slice(0, 4));
  if (labels.length > 4) {
    growTrackCard({ resultKey: `${staged.msgId}::0`, baseResult: staged.baseResult }, staged.proposal, labels.slice(4).map(action));
  }
  const history = await fetchMessagesForConversation(staged.conversationId);
  const view = render(<Thread history={history} superseded={opts.superseded} onGrown={opts.onGrown} />);
  return { ...staged, view };
}

const checked = (v: ReturnType<typeof render>, i: number) => v.getByTestId(`track-option-${i}`).props.accessibilityState.checked;
const getActive = () => firstValueFrom(observeActive());
const never = () => new Promise<never>(() => {});
const flatten = (n: { props: { style?: unknown } }) => StyleSheet.flatten(n.props.style as never) ?? {};
/** Climbs from a host node to the first ancestor that carries a numeric minHeight or height. */
function frameHeight(node: { props: { style?: unknown }; parent: unknown }): number {
  let cur = node as { props: { style?: unknown }; parent: unknown } | null;
  while (cur) {
    const s = flatten(cur) as { minHeight?: number; height?: number };
    const h = s.minHeight ?? s.height;
    if (typeof h === 'number') return h;
    cur = cur.parent as typeof cur;
  }
  return 0;
}

beforeAll(() => {
  initI18nEn();
  registerCopy();
});
beforeEach(() => {
  resetChatModules();
  jest.spyOn(trackActions, 'syncFollowedStoryNow').mockResolvedValue();
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  jest.spyOn(chatSession, 'canRequestMoreOptions').mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());

describe('ticking and Follow', () => {
  it('a fresh card ticks its first row only', async () => {
    const { view } = await mount(['Artemis II launch', 'NASA Artemis program', 'Moon race']);
    expect(checked(view, 0)).toBe(true);
    expect(checked(view, 1)).toBe(false);
    expect(view.getByText(key('cardTitle'))).toBeTruthy();
    expect(within(view.getByTestId('track-follow')).getByText('trackedStories.followTicked_one:1')).toBeTruthy();
  });

  it('ticking three rows follows three stories, each under its own label and search', async () => {
    const { view, proposal } = await mount(['Artemis II launch', 'NASA Artemis program', 'Moon race']);
    fireEvent.press(view.getByTestId('track-option-1'));
    fireEvent.press(view.getByTestId('track-option-2'));
    expect(within(view.getByTestId('track-follow')).getByText('trackedStories.followTicked_other:3')).toBeTruthy();

    fireEvent.press(view.getByTestId('track-follow'));

    await waitFor(async () => expect(await getActive()).toHaveLength(3));
    const rows = await getActive();
    expect(rows.map((r) => [r.llmHeadline, r.topicText]).sort()).toEqual([
      ['Artemis II launch', 'artemis ii launch'],
      ['Moon race', 'moon race'],
      ['NASA Artemis program', 'nasa artemis program'],
    ]);
    await waitFor(() => expect(view.getAllByText(key('rowFollowing'))).toHaveLength(3));
    expect(view.queryByTestId('track-option-0')).toBeNull();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('trackedStories.followingAll_other:3');
    expect(useFloatingChatStore.getState().resolvedProposals[proposal.id]).toBe('applied');
  });

  it('one failed row says so, stays ticked, offers Try again and leaves the proposal waiting', async () => {
    const { view, proposal } = await mount(['Artemis II launch', 'Moon race']);
    fireEvent.press(view.getByTestId('track-option-1'));
    const real = trackActions.trackStoryWithProposal;
    jest
      .spyOn(trackActions, 'trackStoryWithProposal')
      .mockImplementation((subj, scope, opts) => (scope.label === 'Moon race' ? Promise.reject(new Error('db down')) : real(subj, scope, opts)));

    fireEvent.press(view.getByTestId('track-follow'));

    // The checkbox row's words sit under a hidden visual: its label carries the outcome.
    await waitFor(() => expect(view.getByTestId('track-option-1').props.accessibilityLabel).toBe(`Moon race. ${key('rowFailed')}`));
    expect(view.getByText(key('rowFollowing'))).toBeTruthy();
    expect(checked(view, 1)).toBe(true);
    expect(within(view.getByTestId('track-follow')).getByText(key('tryAgain'))).toBeTruthy();
    expect(useFloatingChatStore.getState().proposal?.id).toBe(proposal.id);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('trackedStories.followingSome_other:1/2');
  });

  it('with nothing ticked Follow reads plain and is disabled', async () => {
    const { view } = await mount(['Artemis II launch', 'Moon race']);
    fireEvent.press(view.getByTestId('track-option-0'));
    const follow = view.getByTestId('track-follow');
    expect(within(follow).getByText(key('follow'))).toBeTruthy();
    expect(follow.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(follow);
    expect(await getActive()).toHaveLength(0);
  });
});

describe('More options', () => {
  const eight = Array.from({ length: 8 }, (_, i) => `Story number ${i}`);

  it('shows on a short pending card', async () => {
    const { view } = await mount(['Artemis II launch']);
    expect(view.getByTestId('track-more').props.accessibilityState.disabled).toBe(false);
    expect(view.getByTestId('track-more').props.accessibilityLabel).toBe(key('moreOptions'));
  });

  it('is hidden at eight options, while a turn runs, and when the engine cannot grow a card', async () => {
    const full = await mount(eight);
    expect(full.view.queryByTestId('track-more')).toBeNull();
    full.view.unmount();

    resetChatModules();
    const short = await mount(['Artemis II launch']);
    act(() => useFloatingChatStore.setState({ isGenerating: true }));
    expect(short.view.queryByTestId('track-more')).toBeNull();
    act(() => useFloatingChatStore.setState({ isGenerating: false }));
    expect(short.view.getByTestId('track-more')).toBeTruthy();
    short.view.unmount();

    (chatSession.canRequestMoreOptions as jest.Mock).mockReturnValue(false);
    const noEngine = await mount(['Artemis II launch']);
    expect(noEngine.view.queryByTestId('track-more')).toBeNull();
  });

  it('while loading, a spinner row takes its place and Follow and Not now stay enabled', async () => {
    const { view } = await mount(['Artemis II launch']);
    jest.spyOn(chatSession, 'requestMoreOptions').mockImplementation(never);

    fireEvent.press(view.getByTestId('track-more'));

    await waitFor(() => expect(view.getByTestId('track-more-loading')).toBeTruthy());
    expect(view.queryByTestId('track-more')).toBeNull();
    expect(view.getByText(key('moreOptionsLoading'))).toBeTruthy();
    expect(view.getByTestId('track-follow').props.accessibilityState.disabled).toBe(false);
    expect(view.getByTestId('track-not-now').props.accessibilityState.disabled).toBe(false);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(key('moreOptionsLoading'));
    expect(frameHeight(view.getByTestId('track-more-loading'))).toBeGreaterThanOrEqual(44);
  });

  it('new options land unticked, focus moves to the first and it scrolls, then it announces after the focus has spoken', async () => {
    const order: string[] = [];
    const focus = jest.spyOn(AccessibilityInfo, 'setAccessibilityFocus').mockImplementation(() => void order.push('focus'));
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockImplementation((s: string) => void order.push(s));
    jest.spyOn(require('react-native'), 'findNodeHandle').mockReturnValue(77);
    const onGrown = jest.fn(() => void order.push('grown'));
    const { view } = await mount(['Artemis II launch'], { onGrown });
    jest.spyOn(chatSession, 'requestMoreOptions').mockResolvedValue({ actions: [action('Moon race'), action('Lunar base')] });

    fireEvent.press(view.getByTestId('track-more'));

    await waitFor(() => expect(view.getByTestId('track-option-2')).toBeTruthy());
    expect(checked(view, 0)).toBe(true);
    expect(checked(view, 1)).toBe(false);
    expect(checked(view, 2)).toBe(false);
    await waitFor(() => expect(onGrown).toHaveBeenCalled());
    expect(focus).toHaveBeenCalledWith(77);
    await waitFor(() => expect(order).toContain('trackedStories.moreOptionsAdded_other:2'), { timeout: 2000 });
    expect(order.filter((o) => o !== key('moreOptionsLoading'))).toEqual(['focus', 'grown', 'trackedStories.moreOptionsAdded_other:2']);
  });

  it.each([
    ['none', { actions: [], reason: 'none' as const }, 'moreOptionsNone'],
    ['failed', { actions: [], reason: 'failed' as const }, 'moreOptionsFailed'],
  ])('%s: the line shows under the rows and More stays', async (_n, answer, line) => {
    const { view } = await mount(['Artemis II launch']);
    jest.spyOn(chatSession, 'requestMoreOptions').mockResolvedValue(answer);

    fireEvent.press(view.getByTestId('track-more'));

    await waitFor(() => expect(view.getByText(key(line))).toBeTruthy());
    expect(view.getByTestId('track-more')).toBeTruthy();
  });

  it('a stopped request leaves no line', async () => {
    const { view } = await mount(['Artemis II launch']);
    jest.spyOn(chatSession, 'requestMoreOptions').mockResolvedValue({ actions: [], reason: 'stopped' });

    fireEvent.press(view.getByTestId('track-more'));

    await waitFor(() => expect(view.getByTestId('track-more')).toBeTruthy());
    expect(view.queryByText(key('moreOptionsNone'))).toBeNull();
    expect(view.queryByText(key('moreOptionsFailed'))).toBeNull();
  });
});

describe('resolved states', () => {
  it('a card with no outcomes that a newer card replaced reads Options expired and offers nothing', async () => {
    const { view } = await mount(['Artemis II launch', 'Moon race'], { superseded: true });
    expect(view.getByText(key('optionsExpired'))).toBeTruthy();
    expect(view.queryByTestId('track-follow')).toBeNull();
    expect(view.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('a followed card stays resolved when a newer card supersedes it', async () => {
    const { view, conversationId } = await mount(['Artemis II launch', 'Moon race']);
    fireEvent.press(view.getByTestId('track-follow'));
    await waitFor(() => expect(view.getByText(key('rowFollowing'))).toBeTruthy());
    view.unmount();

    const history = await fetchMessagesForConversation(conversationId);
    const again = render(<Thread history={history} superseded />);
    expect(again.getByText(key('rowFollowing'))).toBeTruthy();
    expect(again.queryByText(key('optionsExpired'))).toBeNull();
  });

  it('a followed row reads Following, a never-ticked row reads plain, and neither is a checkbox', async () => {
    const { view } = await mount(['Artemis II launch', 'Moon race']);
    fireEvent.press(view.getByTestId('track-follow'));

    await waitFor(() => expect(view.getByText(key('rowFollowing'))).toBeTruthy());
    expect(view.getByText('trackedStories.followingAll_one:1')).toBeTruthy();
    expect(view.queryAllByRole('checkbox')).toHaveLength(0);
    const plain = view.getByTestId('track-row-1');
    expect(plain.props.accessibilityLabel).toBe('Moon race');
    expect(view.getByTestId('track-row-0').props.accessibilityLabel).toBe(`Artemis II launch, ${key('rowFollowing')}`);
    expect(view.queryByTestId('track-more')).toBeNull();
  });

  it('Not now collapses the card to one line', async () => {
    const { view, proposal } = await mount(['Artemis II launch', 'Moon race']);
    fireEvent.press(view.getByTestId('track-not-now'));

    await waitFor(() => expect(view.queryByTestId('track-follow')).toBeNull());
    expect(view.getByText(cancelText())).toBeTruthy();
    expect(view.queryByText('Artemis II launch')).toBeNull();
    expect(useFloatingChatStore.getState().resolvedProposals[proposal.id]).toBe('cancelled');
  });
});

describe('accessibility and touch frames', () => {
  it('pending rows are checkboxes with a checked state', async () => {
    const { view } = await mount(['Artemis II launch', 'Moon race']);
    const boxes = view.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes.map((b) => b.props.accessibilityState.checked)).toEqual([true, false]);
  });

  it('every row, More and each button has a numeric frame of at least 44', async () => {
    const { view } = await mount(['Artemis II launch', 'Moon race']);
    for (const id of ['track-option-0', 'track-option-1', 'track-more', 'track-follow', 'track-not-now']) {
      expect(frameHeight(view.getByTestId(id))).toBeGreaterThanOrEqual(44);
    }
  });

  it('buttons stack once a label wraps and stay stacked when the stacked label fits', async () => {
    // The jest preset reports a font scale of 2, which stacks on its own.
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1);
    const { view } = await mount(['Artemis II launch', 'Moon race']);
    // Side by side, each button takes half the row (flex 1); stacked, it does not.
    const sideBySide = () => (flatten(view.getByTestId('track-follow')) as { flex?: number }).flex === 1;
    const label = () => view.getByText('trackedStories.followTicked_one:1');
    expect(sideBySide()).toBe(true);

    fireEvent(label(), 'textLayout', { nativeEvent: { lines: [{}, {}] } });
    expect(sideBySide()).toBe(false);
    fireEvent(label(), 'textLayout', { nativeEvent: { lines: [{}] } });
    expect(sideBySide()).toBe(false);
  });
});
