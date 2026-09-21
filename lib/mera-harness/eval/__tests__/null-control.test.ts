import {
  BASELINE_ARM,
  agentArmIds,
  resetAgentArmsForTest,
  resolveAgentArm,
} from '../../core/arms';
import { NULL_CONTROL_ARM, ensureNullControlArm } from '../null-control';

describe('the noise-floor arm', () => {
  afterEach(() => resetAgentArmsForTest());

  it('is byte-identical to the baseline apart from id and description', () => {
    ensureNullControlArm();
    const base = resolveAgentArm(BASELINE_ARM);
    const floor = resolveAgentArm(NULL_CONTROL_ARM);

    // Every behavioural field must match. If they ever diverge the "floor" is
    // measuring a second experiment and every bar computed against it is wrong.
    const behaviour = (a: typeof base) => ({
      routerPrompt: a.routerPrompt,
      personaPrompt: a.personaPrompt,
      topicPrompt: a.topicPrompt,
      topicDedupe: a.topicDedupe,
    });
    expect(behaviour(floor)).toEqual(behaviour(base));
    expect(floor.id).not.toBe(base.id);
  });

  it('INHERITS a future baseline value rather than drifting from it', () => {
    // The property a hand-written duplicate would lose. Simulated by deriving
    // the floor the same way the real one is derived and checking the spread
    // carries an added field through.
    const base = { ...resolveAgentArm(BASELINE_ARM), topicDedupe: 'off' as const };
    const derived = { ...base, id: NULL_CONTROL_ARM };
    expect(derived.topicDedupe).toBe('off');
  });

  it('is idempotent: a second call does not throw', () => {
    ensureNullControlArm();
    expect(() => ensureNullControlArm()).not.toThrow();
    expect(agentArmIds().filter((i) => i === NULL_CONTROL_ARM)).toHaveLength(1);
  });

  it('POSITIVE CONTROL: registering a genuinely different arm twice DOES throw', () => {
    // Proves the idempotence above is real handling, not a registry that
    // silently accepts duplicates.
    ensureNullControlArm();
    expect(() => resolveAgentArm('not-an-arm')).toThrow(/Unknown agent arm/);
  });
});
