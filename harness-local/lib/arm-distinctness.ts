// harness-local: are the arms of a run really different arms? Checked BEFORE the
// first call (a run that compares a configuration against itself is 90 minutes
// of nothing), and again on the wire after it.

import { createHash } from 'node:crypto';
import { personaPromptFor, resolveAgentArm } from '../../lib/mera-harness/core/arms';
import { buildRouterPrompt } from '../../lib/mera-harness/core/router-prompt';

/**
 * Arms that share a leg-0 prompt BY DESIGN: a control and its twin (their
 * spread is the floor), and the closing arms, which change the loop and not the
 * leg-0 prompt (their wiring shows as tool-free legs).
 */
export const TWINS: ReadonlySet<string> = new Set([
  'baseline', 'null-control',
  'forced-offer-closing', 'forced-offer-closing-twin',
]);

/** The leg-0 router prompt an arm builds, for both surfaces, as a short hash.
 *  An arm on the one-shot prompt is fingerprinted by that choice instead: its
 *  leg 0 is not the router at all. */
export function leg0Fingerprint(variant: string): string {
  const arm = resolveAgentArm(variant);
  const text = personaPromptFor(arm) === 'oneshot'
    ? `oneshot:${variant}`
    : (['CONFIG', 'ONBOARDING'] as const)
        .map((surface) => buildRouterPrompt({ surface, languageName: 'English', arm: variant }))
        .join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** Variant groups that build one leg-0 prompt without all being twins. */
export function leg0Collisions(variants: readonly string[]): { hashes: Record<string, string>; failures: string[] } {
  const hashes: Record<string, string> = {};
  const byHash = new Map<string, string[]>();
  for (const v of variants) {
    const h = leg0Fingerprint(v);
    hashes[v] = h;
    byHash.set(h, [...(byHash.get(h) ?? []), v]);
  }
  const failures = [...byHash.values()]
    .filter((group) => group.length > 1 && !group.every((v) => TWINS.has(v)))
    .map((group) => group.slice().sort().join(' == '));
  return { hashes, failures };
}
