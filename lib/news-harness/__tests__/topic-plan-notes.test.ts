// topic-plan-notes — what Mera is told when a card is answered.
//
// Two assertions here are contracts other code depends on:
//   1. `undefined` for no notes, which is what keeps buildPersonaContext's call
//      args byte-identical for every user who has answered no cards.
//   2. A hard token ceiling, because the on-device turn ABORTS rather than
//      shrinks when the input budget is blown.

import {
  buildTopicPlanTurnBody,
  formatTopicPlanNotesBlock,
  type TopicPlanNote,
} from '../persona-management/topic-plan-notes';
import { estimateTokens } from '../../llm/tokens';

const saved = (statement: string, kept: string[] = [], removed: string[] = []): TopicPlanNote => ({
  kind: 'saved',
  statement,
  kept,
  removed,
  at: 1,
});
const discarded = (statement: string): TopicPlanNote => ({ kind: 'discarded', statement, at: 2 });

describe('formatTopicPlanNotesBlock', () => {
  // THE BYTE-IDENTICAL CONTRACT, asserted at its source.
  it('returns undefined when there is nothing to say', () => {
    expect(formatTopicPlanNotesBlock()).toBeUndefined();
    expect(formatTopicPlanNotesBlock([])).toBeUndefined();
  });

  it('records a save with what was kept and what the user trimmed', () => {
    const block = formatTopicPlanNotesBlock([
      saved('I follow Formula 1', ['F1 race results'], ['F1 merchandise']),
    ]);
    expect(block).toContain('KEPT');
    expect(block).toContain('I follow Formula 1');
    expect(block).toContain('F1 race results');
    expect(block).toContain('F1 merchandise');
  });

  it('records a discard as deleted, and tells the model not to re-save it', () => {
    const block = formatTopicPlanNotesBlock([discarded('I follow Formula 1')]);
    expect(block).toContain('REJECTED');
    expect(block).toMatch(/do not save it again/i);
  });

  it('renders at most two notes, and says how many it hid', () => {
    const block = formatTopicPlanNotesBlock([
      discarded('one'),
      discarded('two'),
      discarded('three'),
      discarded('four'),
    ]);
    expect(block).toContain('and 2 earlier decisions');
    expect(block).not.toContain('"one"');
  });

  it('truncates a long statement and a long topic list', () => {
    const block = formatTopicPlanNotesBlock([
      saved('x'.repeat(300), ['a'.repeat(200), 'b', 'c', 'd', 'e']),
    ])!;
    expect(block).toContain('…');
    expect(block).toContain('+2 more');
  });

  // The on-device path ABORTS on overflow rather than shrinking, so this is a
  // ceiling, not a preference.
  it('stays small enough that it cannot blow the on-device budget', () => {
    const block = formatTopicPlanNotesBlock([
      saved('x'.repeat(300), Array.from({ length: 20 }, () => 'y'.repeat(100))),
      saved('z'.repeat(300), Array.from({ length: 20 }, () => 'w'.repeat(100))),
      discarded('q'.repeat(300)),
    ])!;
    expect(estimateTokens(block)).toBeLessThan(140);
  });
});

describe('buildTopicPlanTurnBody', () => {
  it('is empty when nothing was discarded — a save asks for no reply', () => {
    expect(buildTopicPlanTurnBody([saved('I follow Formula 1')])).toBe('');
  });

  it('tells the model it is not a user message, and to save nothing', () => {
    const body = buildTopicPlanTurnBody([discarded('I follow Formula 1')]);
    expect(body).toContain('SYSTEM NOTE');
    expect(body).toMatch(/not a message from the user/i);
    expect(body).toMatch(/empty array/i);
  });

  it('offers alternatives OR a question for a single discard', () => {
    const body = buildTopicPlanTurnBody([discarded('I follow Formula 1')]);
    expect(body).toContain('(a)');
    expect(body).toContain('(b)');
  });

  // Rejecting everything at once is a signal about HOW topics are chosen, so the
  // multi variant asks a question instead of offering 6-9 replacements.
  it('asks a question and does NOT offer replacements when everything was rejected', () => {
    const body = buildTopicPlanTurnBody([discarded('one thing'), discarded('another thing')]);
    expect(body).toMatch(/HOW you are choosing topics/);
    expect(body).toMatch(/Do NOT offer replacement topics/);
    expect(body).not.toContain('(a)');
  });

  it('names what the user KEPT in a mixed batch, so it is not re-proposed', () => {
    const body = buildTopicPlanTurnBody([saved('I live in Lisbon'), discarded('I follow F1')]);
    expect(body).toContain('KEPT');
    expect(body).toContain('I live in Lisbon');
  });

  it('compact is materially shorter, for the 3072-token on-device budget', () => {
    const notes = [discarded('I follow Formula 1')];
    const full = buildTopicPlanTurnBody(notes);
    const compact = buildTopicPlanTurnBody(notes, { compact: true });
    expect(estimateTokens(compact)).toBeLessThan(estimateTokens(full) / 2);
    // It still carries the two load-bearing instructions.
    expect(compact).toMatch(/do not save them again/i);
    expect(compact).toMatch(/empty array/i);
  });
});
