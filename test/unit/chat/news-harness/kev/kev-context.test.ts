import type { DecisionChoiceAnswer, DecisionQuestions, DecisionScoreAnswer } from 'llama.rn';
import {
  choiceLine,
  confidenceWord,
  formatDecision,
  intentLine,
  relevanceLine,
  targetFactLine,
} from '@/lib/news-harness/on-device/kev';

const choice = (probabilities: Record<string, number>): DecisionChoiceAnswer => ({
  type: 'choice',
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0],
  probabilities,
  confidence: 0.5,
});

const INTENT = {
  share_new_fact: 'share a new fact about themselves',
  remove_fact: 'remove a saved fact',
  question_or_chat: null,
};
const FACTS = { f1: 'Lives in Porto', f2: 'Works as a nurse', none: null };

describe('confidenceWord', () => {
  it.each([
    [1, 'very likely'],
    [0.8, 'very likely'],
    [0.79, 'likely'],
    [0.6, 'likely'],
    [0.59, 'unsure'],
    [0, 'unsure'],
  ])('%p is %p', (p, word) => {
    expect(confidenceWord(p)).toBe(word);
  });
});

describe('intentLine', () => {
  it('names the chosen option in words with the confidence word and 2 decimals', () => {
    expect(intentLine(choice({ remove_fact: 0.912, share_new_fact: 0.05, question_or_chat: 0.038 }), INTENT)).toBe(
      'What the user wants: remove a saved fact (very likely, 0.91)',
    );
  });

  it('adds the runner-up when it is within 0.2', () => {
    expect(intentLine(choice({ remove_fact: 0.5, share_new_fact: 0.35, question_or_chat: 0.15 }), INTENT)).toBe(
      'What the user wants: remove a saved fact (unsure, 0.50), or maybe: share a new fact about themselves (0.35)',
    );
  });

  it('leaves the runner-up out at a gap of exactly 0.2', () => {
    expect(intentLine(choice({ remove_fact: 0.6, share_new_fact: 0.4 }), INTENT)).not.toContain('or maybe');
  });

  it('falls back to the key in words when the description is null', () => {
    expect(intentLine(choice({ question_or_chat: 0.9, remove_fact: 0.1 }), INTENT)).toBe(
      'What the user wants: question or chat (very likely, 0.90)',
    );
  });

  it('breaks a tie by the criteria order, the same on every call', () => {
    const tie = choice({ remove_fact: 0.5, share_new_fact: 0.5 });
    const line = 'What the user wants: share a new fact about themselves (unsure, 0.50), or maybe: remove a saved fact (0.50)';
    expect(intentLine(tie, INTENT)).toBe(line);
    expect(intentLine({ ...tie, probabilities: { share_new_fact: 0.5, remove_fact: 0.5 } }, INTENT)).toBe(line);
  });

  it('takes a custom label', () => {
    expect(intentLine(choice({ remove_fact: 1 }), INTENT, 'They want')).toBe('They want: remove a saved fact (very likely, 1.00)');
  });
});

describe('targetFactLine', () => {
  it('quotes the fact', () => {
    expect(targetFactLine(choice({ f1: 0.74, f2: 0.2, none: 0.06 }), FACTS)).toBe(
      'The fact they mean: "Lives in Porto" (likely, 0.74)',
    );
  });

  it('reads none as none of the saved facts, unquoted, also as the runner-up', () => {
    expect(targetFactLine(choice({ none: 0.7, f1: 0.3 }), FACTS)).toBe(
      'The fact they mean: none of the saved facts (likely, 0.70)',
    );
    expect(targetFactLine(choice({ f2: 0.5, none: 0.45, f1: 0.05 }), FACTS)).toBe(
      'The fact they mean: "Works as a nurse" (unsure, 0.50), or maybe: none of the saved facts (0.45)',
    );
  });

  it('takes a custom none key and label', () => {
    expect(targetFactLine(choice({ nofact: 0.9, f1: 0.1 }), { f1: 'Lives in Porto', nofact: null }, { noneKey: 'nofact', label: 'Which fact' })).toBe(
      'Which fact: none of the saved facts (very likely, 0.90)',
    );
  });
});

describe('relevanceLine', () => {
  const score = (probabilities: Record<string, number>): DecisionScoreAnswer => ({
    type: 'score',
    score: 2.1,
    legend: { '0': 'Not relevant', '1': 'Low', '2': 'Medium: clearly about one of their interests', '3': 'High' },
    probabilities,
    confidence: 0.4,
  });

  it('names the likeliest level from the answer legend', () => {
    expect(relevanceLine(score({ '0': 0.05, '1': 0.1, '2': 0.7, '3': 0.15 }))).toBe(
      'How relevant this is to them: Medium: clearly about one of their interests (likely, 0.70)',
    );
  });

  it('breaks a level tie toward the lower level', () => {
    expect(relevanceLine(score({ '3': 0.45, '2': 0.45, '1': 0.1 }), 'Relevance')).toBe(
      'Relevance: Medium: clearly about one of their interests (unsure, 0.45), or maybe: High (0.45)',
    );
  });
});

describe('choiceLine', () => {
  it('says nothing was decided for an empty answer', () => {
    expect(choiceLine('Intent', { probabilities: {} })).toBe('Intent: nothing decided');
  });

  it('clips a long description', () => {
    const line = choiceLine('Intent', { probabilities: { a: 1 } }, { describe: () => 'word '.repeat(60) });
    expect(line.length).toBeLessThan(160);
    expect(line).toContain('...');
  });
});

describe('formatDecision', () => {
  const questions: DecisionQuestions = {
    intent: { type: 'choice', instructions: 'What does the user want?', criteria: INTENT },
    target: { type: 'choice', instructions: 'Which saved fact?', criteria: FACTS },
    rel: { type: 'score', instructions: 'How relevant?', criteria: ['No', 'Yes'] },
    sure: { type: 'noul', instructions: 'Is it about them?', criteria: { true: 'about the user', false: 'about someone else' } },
  };
  const answers = {
    intent: choice({ remove_fact: 0.91, share_new_fact: 0.09 }),
    target: choice({ f1: 0.74, f2: 0.2, none: 0.06 }),
  };

  it('renders one line per answered question in the questions order', () => {
    expect(
      formatDecision(questions, answers, {
        labels: { intent: 'What the user wants', target: 'The fact they mean' },
        quote: ['target'],
      }),
    ).toBe('What the user wants: remove a saved fact (very likely, 0.91)\nThe fact they mean: "Lives in Porto" (likely, 0.74)');
  });

  it('follows an explicit order and labels a question by its id in words by default', () => {
    expect(formatDecision(questions, answers, { order: ['target', 'intent'] }).split('\n')).toEqual([
      'target: Lives in Porto (likely, 0.74)',
      'intent: remove a saved fact (very likely, 0.91)',
    ]);
  });

  it('renders score and noul answers', () => {
    const out = formatDecision(
      { rel: questions.rel, sure: questions.sure },
      {
        rel: { type: 'score', score: 1, legend: { '0': 'No', '1': 'Yes' }, probabilities: { '0': 0.1, '1': 0.9 }, confidence: 0.6 },
        sure: { type: 'noul', noul: 0.3 },
      },
      { labels: { rel: 'Relevant', sure: 'About them' } },
    );
    expect(out).toBe('Relevant: Yes (very likely, 0.90)\nAbout them: about someone else (likely, 0.70)');
  });

  it('falls back to yes and no for a noul without criteria', () => {
    expect(
      formatDecision({ q: { type: 'noul', instructions: 'x' } }, { q: { type: 'noul', noul: 0.95 } }),
    ).toBe('q: yes (very likely, 0.95)');
  });

  it('skips questions without an answer and a mismatched answer type', () => {
    expect(formatDecision(questions, { intent: { type: 'noul', noul: 1 } })).toBe('');
  });

  it('appends extra lines and drops them first over the cap', () => {
    const full = formatDecision(questions, answers, { extra: ['Card waiting: none'] });
    expect(full.split('\n')).toHaveLength(3);
    const capped = formatDecision(questions, answers, { extra: ['Card waiting: none'], maxChars: 100 });
    expect(capped.split('\n')).toHaveLength(2);
  });

  it('cuts a lone line that is over the cap', () => {
    const out = formatDecision(questions, { intent: answers.intent }, { maxChars: 30 });
    expect(Array.from(out).length).toBeLessThanOrEqual(30);
    expect(out.endsWith('...')).toBe(true);
  });

  it('never carries JSON or a model name', () => {
    const out = formatDecision(questions, answers, { quote: ['target'] });
    expect(out).not.toMatch(/[{}[\]]/);
    expect(out).not.toMatch(/kev|qwen/i);
  });
});
