// mera-harness/core — the agent's experiment arms. PURE, RN-free.
//
// WHY THESE LIVE HERE and not in lib/news-harness/prompts/prompt-variants.ts:
// that registry's shipped set is pinned by a test outside this wave's write
// set, and more importantly these arms are the HARNESS's, so they belong in
// the folder that is meant to lift out as its own package. The rules are the
// same ones that registry established, because they are the right rules:
//
//   - An arm is a VALUE, never an edit. Deriving an arm by string surgery over
//     the shipped prompt makes it a function of whatever the file says today,
//     so a result recorded last week stops being reproducible.
//   - 'baseline' is ALWAYS a byte-exact no-op, so a control measures the
//     shipped configuration and nothing else.
//   - An UNKNOWN id THROWS. A typo'd arm that quietly scored the baseline
//     would be written up as a real result, and a wrong number is worse than a
//     crashed run.

export const BASELINE_ARM = 'baseline';

export interface AgentArm {
  id: string;
  description: string;
  /** Whole replacement text for the router system prompt. Never a transform. */
  routerPrompt?: string;
  /** Which persona prompt an agent turn runs on. `oneshot` is the production
   *  control: the shipped one-shot prompt instead of the router. The DRIVER
   *  reads this and picks the builder, because the one-shot prompt lives in
   *  news-harness and this folder imports nothing from there. */
  personaPrompt?: 'router' | 'oneshot';
  /** Which prompt the background topic call runs on. */
  topicPrompt?: 'oneshot' | 'skill';
  /** The within-set near-duplicate filter. Absent means 'overlap', i.e. ON. */
  topicDedupe?: 'off' | 'overlap';
}

const BASELINE: AgentArm = {
  id: BASELINE_ARM,
  description: 'The shipped configuration, unmodified. The control arm.',
};

/**
 * Re-worded decision procedure. That section is the only part of the router
 * that actually decides a route, so it is the only part worth an arm.
 *
 * It MUST produce a different leg-0 prompt from baseline, or the runner's
 * nonce-normalised promptHash cannot tell the two apart and the arm silently
 * measures the control. `arms.test.ts` asserts exactly that.
 */
const ROUTER_V1: AgentArm = {
  id: 'router-v1',
  description:
    'Router prompt with an explicitly numbered match-then-load procedure and a stricter '
    + 'one-question rule. Tests whether routing accuracy moves with the procedure wording.',
  routerPrompt: `You are Mera, updating what you know about this person so their news is worth reading.

## Voice
Write in the user's selected language. Never use an em dash or an en dash; use a comma, a full stop or a colon. No filler openers. Short, plain, specific.

## Procedure, in this exact order
1. Read the state line, then the known facts.
2. Write ONE short sentence acknowledging what they just said, under 200 characters. Do this BEFORE any tool call, every time.
3. Compare their message against the skill index below. Pick the SINGLE closest row and call load_skill with its id. If nothing is close, answer briefly and stop here.
4. Do exactly what the loaded instructions say. They decide what to produce; this prompt does not.
5. Resolve every place with lookup_place before it appears in a fact. Check find_similar_facts before proposing anything that might replace what you already hold.

## Questions
One question per turn at most, and only as the last thing you say. If you asked something last turn and they did not answer it, do not ask again: take the most likely reading and offer it. Prefer the reading that can be undone.

## Scope
Their profile and their news. Redirect anything else in one short line.`,
};

/**
 * The PRODUCTION control: the whole agent turn on the shipped one-shot prompt,
 * and the topic call on the shipped one-shot topic prompt.
 *
 * Without it the eval can only compare a router against another router, while
 * the question that decides the wave is whether any of this beats what ships.
 */
const ONESHOT_PROD: AgentArm = {
  id: 'oneshot-prod',
  description:
    'PRODUCTION CONTROL. The agent turn runs on the shipped one-shot persona prompt and the '
    + 'topic call on the shipped one-shot topic prompt. Compare every agent metric against this.',
  personaPrompt: 'oneshot',
  topicPrompt: 'oneshot',
};

/** Arms that ship. A runner may add more for a throwaway probe. */
const SHIPPED_ARMS: AgentArm[] = [ROUTER_V1, ONESHOT_PROD];

const REGISTRY = new Map<string, AgentArm>([
  [BASELINE_ARM, BASELINE],
  ...SHIPPED_ARMS.map((a) => [a.id, a] as const),
]);

export function agentArmIds(): string[] {
  return [...REGISTRY.keys()];
}

export function resolveAgentArm(id?: string): AgentArm {
  if (id === undefined) return BASELINE;
  const arm = REGISTRY.get(id);
  if (!arm) {
    throw new Error(`Unknown agent arm '${id}'. Registered: ${agentArmIds().join(', ')}.`);
  }
  return arm;
}

/** Cannot replace an existing id, and cannot replace the baseline at all:
 *  every arm is measured against the control, so a mutated control corrupts
 *  every comparison in the run rather than only its own. */
export function registerAgentArm(arm: AgentArm): void {
  if (arm.id === BASELINE_ARM) {
    throw new Error("The 'baseline' arm is the control and cannot be replaced.");
  }
  if (REGISTRY.has(arm.id)) throw new Error(`Agent arm '${arm.id}' is already registered.`);
  REGISTRY.set(arm.id, arm);
}

/** Test-only. Re-seeds the SHIPPED set, not just the baseline: a reset that
 *  dropped shipped arms would unregister them for every test after the first
 *  afterEach in a file, and "the registry starts clean" would then pass for the
 *  wrong reason. */
export function resetAgentArmsForTest(): void {
  REGISTRY.clear();
  REGISTRY.set(BASELINE_ARM, BASELINE);
  for (const arm of SHIPPED_ARMS) REGISTRY.set(arm.id, arm);
}

/** Absent means ON, so the shipped configuration is what gets measured and an
 *  arm has to opt OUT to see the difference. */
export function dedupeModeFor(arm: AgentArm): 'off' | 'overlap' {
  return arm.topicDedupe ?? 'overlap';
}

export function topicPromptFor(arm: AgentArm): 'oneshot' | 'skill' {
  return arm.topicPrompt ?? 'skill';
}

export function personaPromptFor(arm: AgentArm): 'router' | 'oneshot' {
  return arm.personaPrompt ?? 'router';
}
