// Proposal CONSENT rules — pure predicates over a StagedProposal.
//
// Two different seams enforce consent, and they are not interchangeable:
//
//  - ACTION-level: `USER_CONFIRMED_ONLY_ACTIONS` in lib/chat-tools/
//    proposal-handlers.ts. The executor sees only actions, so it can filter
//    `run_calibration` itself.
//  - PROPOSAL-level (this file): `chooseOne` is a property of the CARD, not of
//    any action, and by the time the executor is called the caller has already
//    decided which subset to pass. The executor therefore cannot see the
//    difference between "the user tapped pill 2" and "the model applied all
//    three" — the guard has to live one level up, at each applyProposal.
//
// It lives here, RN-free, rather than in proposal-handlers so the UI and both
// agents can share ONE definition of "single-select" instead of re-deriving
// `chooseOne && actions.length > 1` at every call site.

import type { StagedProposal } from './types';

/** The shape an agent's `applyProposal` returns when it refuses: never a bare
 *  error, always something the model can turn into a useful sentence, and never
 *  accompanied by `sideEffects.proposalResolved` (the card must stay tappable). */
export interface AwaitingUserTapResult extends Record<string, unknown> {
  applied: 0;
  awaitingUserConfirmation: true;
  message: string;
}

/**
 * True when the staged card is SINGLE-SELECT: its actions are mutually-exclusive
 * alternatives and only the user's tap knows which one they meant.
 *
 * `chooseOne` with a lone action is NOT a choice — ProposalCard renders it as a
 * plain confirm — so this returns false there and the proposal stays applicable
 * from chat, exactly as the card behaves.
 */
export function proposalRequiresUserChoice(
  proposal: Pick<StagedProposal, 'actions'> & { chooseOne?: boolean },
): boolean {
  return proposal.chooseOne === true && proposal.actions.length > 1;
}

/**
 * Refusal for a single-select card. Applying every alternative is not "doing
 * what the user asked" — on the Track surface a typed "yes" against a 3-pill
 * card would mint three topics AND three followed stories. Consent is the tap.
 */
export function chooseOneRefusal(): AwaitingUserTapResult {
  return {
    applied: 0,
    awaitingUserConfirmation: true,
    message:
      'These options are alternatives — the user must TAP the one they want on the card. '
      + 'Tell them the options are ready and ask them to pick one; do not claim anything was done.',
  };
}

/**
 * Refusal for a proposal whose only remaining actions are user-confirmed-only
 * (today: `run_calibration`). Same contract: card survives, model gets words.
 */
export function userTapOnlyRefusal(): AwaitingUserTapResult {
  return {
    applied: 0,
    awaitingUserConfirmation: true,
    message:
      'This change needs the user to tap Confirm on the card. Tell them it is ready and waiting; do not claim it is done.',
  };
}
