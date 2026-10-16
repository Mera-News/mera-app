// mera-harness/eval — candidate 3 of the E2EE tool-steps plan, as a measurement arm.
//
// Under the text tool protocol most persona turns with no closing sentence end
// on the forced offer: it is the LAST leg of the budget, so the one closing leg
// a silent proposal earns is swallowed by the cap, and the user sees a card and
// no sentence. `forcedOfferClosing: 'on'` grants that leg, with no tools.
// Registered by the runner, not shipped, until the corpus run in
// plans/ready_to_implement/E2EE_TOOL_STEPS_DEV_PORT.md passes. Both arms change
// no leg-0 prompt, so they are each other's twin.

import { BASELINE_ARM, agentArmIds, registerAgentArm, resolveAgentArm } from '../core/arms';

export const FORCED_OFFER_CLOSING_ARM_ID = 'forced-offer-closing';
export const FORCED_OFFER_CLOSING_TWIN_ARM_ID = 'forced-offer-closing-twin';

/** Idempotent, like `ensureNullControlArm`. */
export function ensureForcedOfferClosingArms(): void {
  for (const id of [FORCED_OFFER_CLOSING_ARM_ID, FORCED_OFFER_CLOSING_TWIN_ARM_ID]) {
    if (agentArmIds().includes(id)) continue;
    registerAgentArm({
      ...resolveAgentArm(BASELINE_ARM),
      id,
      description: 'Baseline plus one tool-free closing-sentence leg after a silent forced offer.',
      forcedOfferClosing: 'on',
    });
  }
}

/**
 * core/core.ts CLOSING_LINE_NOTE, re-declared (the core does not export it and
 * the eval must not move when the core's wording does without saying so: a test
 * proves this text is still in core.ts). It is the one marker of a CLOSING leg.
 */
export const CLOSING_LINE_NOTE_TEXT =
  'You offered the card above. Nothing is saved until the user taps it. '
  + 'Write ONE short sentence to the user about what you offered. Do not ask a question. Do not call a tool.';

/**
 * A closing leg is a tool-free leg whose messages carry the closing-line note.
 * "Sent with no tools" is NOT enough: the about-mera answer leg is tool-free by
 * design, so counting every empty tool list tripped the wiring check on every
 * non-closing arm.
 */
export function isClosingLeg(req: { tools?: unknown[]; messages: { content: string }[] }): boolean {
  return Array.isArray(req.tools) && req.tools.length === 0
    && req.messages.some((m) => m.content.includes(CLOSING_LINE_NOTE_TEXT));
}

/** Closing legs must appear in every closing arm and nowhere else. */
export function closingWiringFailures(
  arms: Iterable<string>,
  closingLegsByArm: ReadonlyMap<string, { legs: number }>,
  dryRun: boolean,
): string[] {
  const wiring: string[] = [];
  for (const arm of new Set(arms)) {
    const closing = /@forced-offer-closing(-twin)?(\+|$)/.test(arm);
    const n = closingLegsByArm.get(arm)?.legs ?? 0;
    if (!dryRun && closing && n === 0) wiring.push(`  ${arm}: no tool-free leg, so the closing arm never fired`);
    if (!closing && n > 0) wiring.push(`  ${arm}: ${n} tool-free leg(s) on an arm without the closing leg`);
  }
  return wiring;
}
