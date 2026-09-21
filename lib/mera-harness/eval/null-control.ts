// mera-harness/eval — the noise-floor arm.
//
// DERIVED FROM THE BASELINE, NEVER A SECOND COPY OF ITS VALUES. The floor's
// entire guarantee is that this arm is byte-identical to the control, so its
// gap against baseline inside one run IS the noise floor every acceptance bar
// is judged against. A hand-written duplicate holds that property only until
// someone adds a value to the baseline and forgets this file; a spread of the
// resolved baseline object holds it by construction and inherits any future
// field automatically.
//
// It lives here rather than in core/arms.ts because it is a MEASUREMENT
// device, not a shipped configuration: nothing in the app needs it, and the
// arms module is the list of things the app can actually be run as.

import { BASELINE_ARM, agentArmIds, registerAgentArm, resolveAgentArm } from '../core/arms';

export const NULL_CONTROL_ARM = 'null-control';

/**
 * Registers the floor arm if it is not already there. Idempotent, because
 * `registerAgentArm` throws on a second registration and a runner that
 * imports this module twice must not die for it.
 */
export function ensureNullControlArm(): void {
  if (agentArmIds().includes(NULL_CONTROL_ARM)) return;
  registerAgentArm({
    ...resolveAgentArm(BASELINE_ARM),
    id: NULL_CONTROL_ARM,
    description:
      'Byte-identical to baseline BY CONSTRUCTION: a spread of the resolved baseline arm with a '
      + 'different id, so it overrides nothing and cannot drift from the control. Its within-run '
      + 'gap against baseline IS the noise floor. Never give it a value of its own.',
  });
}
