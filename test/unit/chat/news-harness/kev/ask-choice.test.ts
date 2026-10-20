import { isFactPickChoice } from '@/lib/mera-harness/core/fact-pick';
import {
  ASK_CHOICE_AWAITING,
  ASK_CHOICE_TOOL,
  buildAskChoice,
  clipLabel,
  readingFromTap,
} from '@/lib/news-harness/on-device/kev';

const LABELS = {
  share_new_fact: 'Save this as a new fact',
  remove_fact: 'Remove a saved fact',
  correct_fact: 'Change a saved fact',
  question_or_chat: 'Just chatting',
};

describe('buildAskChoice', () => {
  it('offers the likeliest readings, highest first, with the Something else flag', () => {
    const ask = buildAskChoice(
      { probabilities: { remove_fact: 0.45, correct_fact: 0.4, share_new_fact: 0.1, question_or_chat: 0.05 } },
      LABELS,
      '  What should I do?  ',
    );
    expect(ask).toEqual({
      question: 'What should I do?',
      options: ['Remove a saved fact', 'Change a saved fact', 'Save this as a new fact'],
      somethingElse: true,
    });
  });

  it('never offers more than 3 readings', () => {
    const ask = buildAskChoice({ probabilities: { remove_fact: 0.25, correct_fact: 0.25, share_new_fact: 0.25, question_or_chat: 0.25 } }, LABELS, 'Q');
    expect(ask?.options).toHaveLength(3);
  });

  it('leaves a third reading under 0.1 out', () => {
    const ask = buildAskChoice({ probabilities: { remove_fact: 0.5, correct_fact: 0.45, share_new_fact: 0.05 } }, LABELS, 'Q');
    expect(ask?.options).toEqual(['Remove a saved fact', 'Change a saved fact']);
  });

  it('skips readings without a label and merges identical labels', () => {
    const ask = buildAskChoice(
      { probabilities: { a: 0.4, b: 0.3, c: 0.2, d: 0.1 } },
      { a: 'Same thing', b: 'Same  thing ', d: 'Other' },
      'Q',
    );
    expect(ask?.options).toEqual(['Same thing', 'Other']);
  });

  it('returns null below 2 options: a single option, no labels, or no probabilities', () => {
    expect(buildAskChoice({ probabilities: { remove_fact: 1 } }, LABELS, 'Q')).toBeNull();
    expect(buildAskChoice({ probabilities: { a: 0.5, b: 0.5 } }, {}, 'Q')).toBeNull();
    expect(buildAskChoice({ probabilities: {} }, LABELS, 'Q')).toBeNull();
  });

  it('breaks a tie by the label map order', () => {
    const ask = buildAskChoice({ probabilities: { correct_fact: 0.5, remove_fact: 0.5 } }, LABELS, 'Q');
    expect(ask?.options).toEqual(['Remove a saved fact', 'Change a saved fact']);
  });

  it('clips long labels to 60 characters', () => {
    const long = 'Remove the saved fact about where your parents live and work these days';
    const ask = buildAskChoice({ probabilities: { a: 0.5, b: 0.5 } }, { a: long, b: 'Keep it' }, 'Q');
    expect(Array.from(ask!.options[0]).length).toBeLessThanOrEqual(60);
  });

  it('labels in the "do something" form are not read as a fact pick by the card', () => {
    const ask = buildAskChoice({ probabilities: { remove_fact: 0.5, correct_fact: 0.4, share_new_fact: 0.1 } }, LABELS, 'Q');
    expect(isFactPickChoice(ask!.options)).toBe(false);
  });

  it('exports the tool name and the result that shows the chips', () => {
    expect(ASK_CHOICE_TOOL).toBe('ask_choice');
    expect(ASK_CHOICE_AWAITING).toEqual({ awaiting: 'user' });
  });
});

describe('clipLabel', () => {
  it('keeps a short label, collapsing spaces', () => {
    expect(clipLabel('  Remove   a fact ')).toBe('Remove a fact');
  });

  it('cuts at a word boundary and drops trailing punctuation', () => {
    const out = clipLabel(`${'word '.repeat(11)}tail, and more words here`);
    expect(Array.from(out).length).toBeLessThanOrEqual(60);
    expect(out).not.toMatch(/[\s,]$/);
  });

  it('hard-cuts a label with no spaces, counting code points', () => {
    expect(Array.from(clipLabel('ä'.repeat(80)))).toHaveLength(60);
    expect(Array.from(clipLabel('😀'.repeat(70)))).toHaveLength(60);
  });
});

describe('readingFromTap', () => {
  it('maps a tapped label back to its reading, ignoring case and spacing', () => {
    expect(readingFromTap('Remove a saved fact', LABELS)).toBe('remove_fact');
    expect(readingFromTap('  change a SAVED fact ', LABELS)).toBe('correct_fact');
  });

  it('matches a long label by its clipped chip text', () => {
    const long = 'Remove the saved fact about where your parents live and work these days';
    expect(readingFromTap(clipLabel(long), { a: long })).toBe('a');
  });

  it('is null for typed text, an empty message or no labels', () => {
    expect(readingFromTap('Remove a saved fact about my job', LABELS)).toBeNull();
    expect(readingFromTap('', LABELS)).toBeNull();
    expect(readingFromTap('Remove a saved fact', {})).toBeNull();
  });
});
