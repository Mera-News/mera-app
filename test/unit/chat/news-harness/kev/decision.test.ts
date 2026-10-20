import type { DecisionChoiceAnswer } from 'llama.rn';
import {
  isUnsure,
  margin,
  ranked,
  runDecision,
  top,
  UNSURE_MIN_CONFIDENCE,
  UNSURE_MIN_MARGIN,
  type DecidePort,
  type DecisionSpec,
} from '@/lib/news-harness/on-device/kev';

const choice = (probabilities: Record<string, number>, pick?: string): DecisionChoiceAnswer => ({
  type: 'choice',
  choice: pick ?? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
  probabilities,
  confidence: 0.5,
});

describe('runDecision', () => {
  const questions = {
    intent: { type: 'choice' as const, instructions: 'What does the user want?', criteria: { save: 'save a fact', chat: null } },
  };
  const spec: DecisionSpec<{ msg: string }, string, typeof questions> = {
    state: (input) => ({ message: input.msg }),
    questions: () => questions,
    read: (answers, input) => `${answers.intent.choice}:${input.msg}`,
  };

  it('makes exactly one decide call with the state and questions, and reads the answers with the input', async () => {
    const answers = { intent: choice({ save: 0.9, chat: 0.1 }) };
    const decide = jest.fn(async () => ({ model: 'm', answers, usage: { input_tokens: 1, output_tokens: 0 } }));
    const run = await runDecision(spec, { msg: 'I live in Porto' }, decide as unknown as DecidePort);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith({ state: { message: 'I live in Porto' }, questions });
    expect(run).toEqual({ decision: 'save:I live in Porto', questions, answers });
  });

  it('propagates a decide failure', async () => {
    const decide = jest.fn(async () => {
      throw new Error('No model loaded.');
    });
    await expect(runDecision(spec, { msg: 'x' }, decide as unknown as DecidePort)).rejects.toThrow('No model loaded.');
  });
});

describe('ranked / top', () => {
  it('sorts by probability, highest first', () => {
    expect(ranked(choice({ a: 0.2, b: 0.7, c: 0.1 })).map((r) => r.key)).toEqual(['b', 'a', 'c']);
  });

  it('breaks a tie by the given key order, then by the chosen key', () => {
    const tie = choice({ b: 0.5, a: 0.5 }, 'b');
    expect(ranked(tie, ['a', 'b']).map((r) => r.key)).toEqual(['a', 'b']);
    expect(ranked(tie, { b: 1, a: 1 }).map((r) => r.key)).toEqual(['b', 'a']);
    expect(ranked(tie).map((r) => r.key)).toEqual(['b', 'a']);
    expect(ranked(choice({ b: 0.5, a: 0.5 }, 'a')).map((r) => r.key)).toEqual(['a', 'b']);
    expect(ranked({ probabilities: { b: 0.5, a: 0.5 } }).map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('puts keys missing from the order after the listed ones', () => {
    expect(ranked({ probabilities: { z: 0.5, a: 0.5 } }, ['z']).map((r) => r.key)).toEqual(['z', 'a']);
  });

  it('top is the first ranked option, or null for no options', () => {
    expect(top(choice({ a: 0.3, b: 0.7 }))).toEqual({ key: 'b', p: 0.7 });
    expect(top({ probabilities: {} })).toBeNull();
  });
});

describe('margin', () => {
  it('is the top-2 gap', () => {
    expect(margin(choice({ a: 0.6, b: 0.3, c: 0.1 }))).toBeCloseTo(0.3);
  });
  it('is the lone option p for a single option, and 0 for none', () => {
    expect(margin(choice({ a: 1 }))).toBe(1);
    expect(margin({ probabilities: {} })).toBe(0);
  });
  it('is 0 for a tie', () => {
    expect(margin(choice({ a: 0.5, b: 0.5 }))).toBe(0);
  });
});

describe('isUnsure (D39)', () => {
  it('uses 0.6 and 0.2 by default', () => {
    expect(UNSURE_MIN_CONFIDENCE).toBe(0.6);
    expect(UNSURE_MIN_MARGIN).toBe(0.2);
  });
  it('is sure with a clear lead', () => {
    expect(isUnsure(choice({ a: 0.85, b: 0.1, c: 0.05 }))).toBe(false);
  });
  it('is unsure under the confidence floor', () => {
    expect(isUnsure(choice({ a: 0.55, b: 0.25, c: 0.2 }))).toBe(true);
  });
  it('is unsure on a close call above the floor', () => {
    expect(isUnsure(choice({ a: 0.61, b: 0.39 }))).toBe(false);
    expect(isUnsure(choice({ a: 0.6, b: 0.41 }))).toBe(true);
  });
  it('sits exactly on the thresholds as sure', () => {
    expect(isUnsure({ probabilities: { a: 0.6, b: 0.4 } }, { minMargin: 0.2 })).toBe(false);
  });
  it('ignores the confidence field', () => {
    const spread: DecisionChoiceAnswer = { ...choice({ a: 0.9, b: 0.1 }), confidence: 0.01 };
    expect(isUnsure(spread)).toBe(false);
  });
  it('is unsure on a tie and on no options, sure on a single option', () => {
    expect(isUnsure(choice({ a: 0.5, b: 0.5 }))).toBe(true);
    expect(isUnsure({ probabilities: {} })).toBe(true);
    expect(isUnsure(choice({ a: 1 }))).toBe(false);
  });
  it('takes custom thresholds', () => {
    expect(isUnsure(choice({ a: 0.7, b: 0.3 }), { minConfidence: 0.8 })).toBe(true);
    expect(isUnsure(choice({ a: 0.7, b: 0.3 }), { minMargin: 0.5 })).toBe(true);
  });
});
