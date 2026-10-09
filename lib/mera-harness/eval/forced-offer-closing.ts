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
