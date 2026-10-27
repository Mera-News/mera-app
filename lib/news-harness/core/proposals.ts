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
 * True when typed agreement must NOT apply the card: a single-select card whose
 * actions are mutually-exclusive alternatives (only the user's tap knows which
 * one they meant), or a follow card holding 2 or more options (see
 * `proposalAllowsMultiSelect`; pass its effective count once it has grown).
 *
 * `chooseOne` with a lone action is NOT a choice — ProposalCard renders it as a
 * plain confirm — so this returns false there and the proposal stays applicable
 * from chat, exactly as the card behaves.
 */
export function proposalRequiresUserChoice(
  proposal: Pick<StagedProposal, 'actions'> & { chooseOne?: boolean },
  effectiveOptionCount?: number,
): boolean {
  return (
    (proposal.chooseOne === true && proposal.actions.length > 1)
    || proposalAllowsMultiSelect(proposal, effectiveOptionCount)
  );
}

/** The phrase every follow-card instruction uses, cloud prompts and the
 *  on-device pending line alike, so the model is told the same thing on both
 *  engines (the parity test greps for it). */
export const TRACK_CARD_TAP_PHRASE = 'tap the ones they want';

/** A FOLLOW card: every action is `track_story`. It always draws as a checkbox
 *  card, even with one option. */
export function isTrackCard(proposal: Pick<StagedProposal, 'actions'>): boolean {
  return proposal.actions.length > 0 && proposal.actions.every((a) => a.type === 'track_story');
}

/**
 * True when the user may tick SEVERAL options: a follow card with 2 or more
 * options. Every other choose-one card stays single-pick.
 *
 * `effectiveOptionCount` is the card's option count after More options grew it
 * (the card keeps grown options in its own tool-result override, not in the
 * staged proposal); omit it when the proposal's actions are the whole card.
 * Such a card is also tap-only: `proposalRequiresUserChoice` folds this in, so
 * typed agreement applies a follow card only while it holds exactly 1 option.
 */
export function proposalAllowsMultiSelect(
  proposal: Pick<StagedProposal, 'actions'>,
  effectiveOptionCount: number = proposal.actions.length,
): boolean {
  return isTrackCard(proposal) && effectiveOptionCount >= 2;
}

/**
 * Refusal for a single-select card. Applying every alternative is not "doing
 * what the user asked" — on the Track surface a typed "yes" against a 3-pill
 * card would mint three topics AND three followed stories. Consent is the tap.
 */
export function chooseOneRefusal(
  proposal?: Pick<StagedProposal, 'actions'>,
): AwaitingUserTapResult {
  if (proposal && isTrackCard(proposal)) {
    return {
      applied: 0,
      awaitingUserConfirmation: true,
      message:
        `These are stories to follow: the user must ${TRACK_CARD_TAP_PHRASE} on the card and then tap Follow. `
        + 'Tell them the options are ready; do not claim anything was followed.',
    };
  }
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
