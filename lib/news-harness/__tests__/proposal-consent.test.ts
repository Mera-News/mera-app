// proposal-consent.test.ts — the PROPOSAL-level consent rule (G1).
//
// `chooseOne` is a property of the CARD, so the action-level guard inside
// executeProposalActions cannot see it; this predicate is the single definition
// every applyProposal and ProposalCard shares.

import {
  chooseOneRefusal,
  proposalRequiresUserChoice,
  userTapOnlyRefusal,
} from '../core/proposals';
import type { ProposalAction, StagedProposal } from '../core/types';

const action = (statement: string): ProposalAction => ({ type: 'add_fact', statement });

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
});
