import {
  BASELINE_ARM,
  agentArmIds,
  dedupeModeFor,
  personaPromptFor,
  registerAgentArm,
  resetAgentArmsForTest,
  resolveAgentArm,
  topicPromptFor,
} from '../arms';
import { buildRouterPrompt } from '../router-prompt';

afterEach(() => resetAgentArmsForTest());

describe('the registry', () => {
  it('ships exactly baseline, router-v1 and oneshot-prod', () => {
    expect(agentArmIds().sort()).toEqual(['baseline', 'oneshot-prod', 'router-v1']);
  });

  it('an UNKNOWN id THROWS rather than quietly scoring the control', () => {
    // A typo'd arm that silently returned baseline would be written up as a
    // real result, and a wrong number is worse than a crashed run.
    expect(() => resolveAgentArm('routerv1')).toThrow(/Unknown agent arm/);
    expect(() => resolveAgentArm('routerv1')).toThrow(/router-v1/); // names the real ones
  });

  it('the baseline cannot be replaced', () => {
    expect(() => registerAgentArm({ id: BASELINE_ARM, description: 'x' })).toThrow(/control/);
  });

  it('the reset RE-SEEDS the shipped arms, not just the baseline', () => {
    registerAgentArm({ id: 'throwaway', description: 'probe' });
    expect(agentArmIds()).toContain('throwaway');
    resetAgentArmsForTest();
    // The failure this guards: dropping shipped arms here unregisters them for
    // every test after the first afterEach, and "starts clean" then passes for
    // the wrong reason.
    expect(agentArmIds().sort()).toEqual(['baseline', 'oneshot-prod', 'router-v1']);
  });
});

describe('defaults are the SHIPPED configuration', () => {
  it('dedupe is ON unless an arm opts out', () => {
    expect(dedupeModeFor(resolveAgentArm())).toBe('overlap');
    expect(dedupeModeFor(resolveAgentArm('router-v1'))).toBe('overlap');
    expect(dedupeModeFor({ id: 'x', description: '', topicDedupe: 'off' })).toBe('off');
  });

  it('baseline runs the router and the skill-guided topic prompt', () => {
    expect(personaPromptFor(resolveAgentArm())).toBe('router');
    expect(topicPromptFor(resolveAgentArm())).toBe('skill');
  });

  it('oneshot-prod is the PRODUCTION control on both halves', () => {
    const arm = resolveAgentArm('oneshot-prod');
    expect(personaPromptFor(arm)).toBe('oneshot');
    expect(topicPromptFor(arm)).toBe('oneshot');
  });
});

describe('baseline is a byte-exact no-op', () => {
  const surfaces = ['ONBOARDING', 'CONFIG'] as const;

  it.each(surfaces)('%s: omitted and "baseline" are identical', (surface) => {
    const omitted = buildRouterPrompt({ surface, languageName: 'English' });
    const explicit = buildRouterPrompt({ surface, languageName: 'English', arm: BASELINE_ARM });
    expect(explicit).toBe(omitted);
  });

  it.each(surfaces)('%s: router-v1 produces a DIFFERENT leg-0 prompt', (surface) => {
    // The runner's nonce-normalised promptHash compares these two. If an arm
    // ever produced the same bytes as baseline it would silently measure the
    // control, so this is the assertion that keeps the arm meaningful.
    const base = buildRouterPrompt({ surface, languageName: 'English' });
    const armed = buildRouterPrompt({ surface, languageName: 'English', arm: 'router-v1' });
    expect(armed).not.toBe(base);
    expect(armed.length).toBeGreaterThan(200);
  });

  it('the arm still honours answerPending, so the rule is not lost with the wording', () => {
    const armed = buildRouterPrompt({ surface: 'CONFIG', arm: 'router-v1', answerPending: true });
    expect(armed).toContain('did NOT answer');
  });

  it('an unknown arm throws out of the BUILDER too, not just the resolver', () => {
    expect(() => buildRouterPrompt({ surface: 'CONFIG', arm: 'nope' })).toThrow(/Unknown agent arm/);
  });
});
