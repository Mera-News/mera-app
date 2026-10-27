// proposal-consent.test.ts — the PROPOSAL-level consent rule (G1).
//
// `chooseOne` is a property of the CARD, so the action-level guard inside
// executeProposalActions cannot see it; this predicate is the single definition
// every applyProposal and ProposalCard shares.

import {
  chooseOneRefusal,
  isTrackCard,
  proposalAllowsMultiSelect,
  proposalRequiresUserChoice,
  TRACK_CARD_TAP_PHRASE,
  userTapOnlyRefusal,
} from '@/lib/news-harness/core/proposals';
import type { ProposalAction, StagedProposal } from '@/lib/news-harness/core/types';

const action = (statement: string): ProposalAction => ({ type: 'add_fact', statement });
const track = (label: string): ProposalAction => ({
  type: 'track_story',
  label,
  searchText: label,
  subject: { origin: 'article', surface: 'detail', articleId: 'a1', title: 't' },
});
const trackCard = (n: number): StagedProposal => ({
  id: 't1',
  explanation: '',
  expectedEffects: '',
  actions: Array.from({ length: n }, (_, i) => track(`Story ${i}`)),
  ...(n >= 2 ? { chooseOne: true } : {}),
});

/** Today's choose-one refusal, pinned: every non-track card must keep it byte for byte. */
const CHOOSE_ONE_MESSAGE =
  'These options are alternatives — the user must TAP the one they want on the card. '
  + 'Tell them the options are ready and ask them to pick one; do not claim anything was done.';

function proposal(overrides: Partial<StagedProposal> = {}): StagedProposal {
  return {
    id: 'p1',
    explanation: '',
    expectedEffects: '',
    actions: [action('a'), action('b')],
    ...overrides,
  };
}

describe('proposalRequiresUserChoice', () => {
  it('is true for a single-select card with ≥2 alternatives', () => {
    expect(proposalRequiresUserChoice(proposal({ chooseOne: true }))).toBe(true);
  });

  it('is false when chooseOne is absent (legacy apply-everything card)', () => {
    expect(proposalRequiresUserChoice(proposal())).toBe(false);
  });

  it('is false when chooseOne is explicitly false', () => {
    expect(proposalRequiresUserChoice(proposal({ chooseOne: false }))).toBe(false);
  });

  it('is false for a lone action — one option is not a choice', () => {
    // Matches ProposalCard, which renders this as a plain confirm. If the
    // predicate said true here, a perfectly confirmable proposal would become
    // unreachable from chat.
    expect(proposalRequiresUserChoice(proposal({ chooseOne: true, actions: [action('a')] }))).toBe(
      false,
    );
  });

  it('is false for an empty action list', () => {
    expect(proposalRequiresUserChoice(proposal({ chooseOne: true, actions: [] }))).toBe(false);
  });
});

describe('track cards (multi-select follow)', () => {
  it('isTrackCard is true only when every action is track_story', () => {
    expect(isTrackCard(trackCard(1))).toBe(true);
    expect(isTrackCard(trackCard(3))).toBe(true);
    expect(isTrackCard(proposal({ chooseOne: true }))).toBe(false);
    expect(isTrackCard(proposal({ actions: [track('a'), action('b')] }))).toBe(false);
    expect(isTrackCard(proposal({ actions: [] }))).toBe(false);
  });

  it('allows multi-select on a track card with 2 or more options', () => {
    expect(proposalAllowsMultiSelect(trackCard(3))).toBe(true);
    expect(proposalAllowsMultiSelect(trackCard(1))).toBe(false);
  });

  it('never allows multi-select on any other choose-one card', () => {
    expect(proposalAllowsMultiSelect(proposal({ chooseOne: true }))).toBe(false);
    expect(
      proposalAllowsMultiSelect(
        proposal({
          chooseOne: true,
          actions: [
            { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
            { type: 'retire_topic', topicText: 'cricket' },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      proposalAllowsMultiSelect(
        proposal({
          chooseOne: true,
          actions: [
            { type: 'fact_check_claim', label: 'a', claim: 'a', subject: { surface: 'detail', articleId: 'x', articleTitle: 't' } },
            { type: 'fact_check_claim', label: 'b', claim: 'b', subject: { surface: 'detail', articleId: 'x', articleTitle: 't' } },
          ],
        }),
      ),
    ).toBe(false);
    expect(proposalAllowsMultiSelect(proposal({ chooseOne: true, actions: [track('a'), action('b')] }))).toBe(false);
  });

  it('counts the EFFECTIVE options: a one-option card grown to 3 is multi-select and tap-only', () => {
    const grown = trackCard(1);
    expect(proposalAllowsMultiSelect(grown, 3)).toBe(true);
    expect(proposalRequiresUserChoice(grown, 3)).toBe(true);
    // Not grown: typed agreement still applies a single-option card.
    expect(proposalRequiresUserChoice(grown)).toBe(false);
    expect(proposalRequiresUserChoice(grown, 1)).toBe(false);
  });

  it('ignores the option count on non-track cards', () => {
    expect(proposalRequiresUserChoice(proposal({ chooseOne: true, actions: [action('a')] }), 3)).toBe(false);
    expect(proposalRequiresUserChoice(proposal(), 3)).toBe(false);
  });
});

describe('refusal results', () => {
  it.each([
    ['chooseOneRefusal', chooseOneRefusal],
    ['userTapOnlyRefusal', userTapOnlyRefusal],
  ])('%s applies nothing but still gives the model words to say', (_name, make) => {
    const r = make();
    expect(r.applied).toBe(0);
    expect(r.awaitingUserConfirmation).toBe(true);
    expect(r.message.length).toBeGreaterThan(0);
    // The refusal must not read as "done" — the model relays this verbatim-ish.
    expect(r.message).toMatch(/do not claim|ask them to pick|TAP/i);
  });

  it('tells the user to pick, not to confirm, on a single-select card', () => {
    expect(chooseOneRefusal().message).toMatch(/TAP/);
  });

  it('keeps every non-track refusal byte-identical', () => {
    expect(chooseOneRefusal().message).toBe(CHOOSE_ONE_MESSAGE);
    expect(chooseOneRefusal(proposal({ chooseOne: true })).message).toBe(CHOOSE_ONE_MESSAGE);
  });

  it('tells the model the user ticks several on a track card', () => {
    const r = chooseOneRefusal(trackCard(3));
    expect(r.applied).toBe(0);
    expect(r.awaitingUserConfirmation).toBe(true);
    expect(r.message).toContain(TRACK_CARD_TAP_PHRASE);
    expect(r.message).toMatch(/do not claim/i);
    expect(r.message).not.toMatch(/[\u2013\u2014]/);
  });
});
