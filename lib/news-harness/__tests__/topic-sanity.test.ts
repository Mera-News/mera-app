// topic-sanity — pure planning + verdict decoding (r12 K-P3).

import {
  planSanityBatches,
  decodeSanityVerdicts,
  renderSanityPrompt,
  SANITY_MAX_TOKENS,
  type SanityTopicInput,
} from '../persona-management/topic-sanity';
import { NOOP_LOGGER, type HarnessLogger } from '../core/ports';

const facts = [
  { id: 'f1', statement: 'Follows the Indian national cricket team' },
  { id: 'f2', statement: 'Parents live in Bhopal' },
];

function topic(id: string, factId: string, text: string, createdAtMs: number): SanityTopicInput {
  return { id, factId, text, createdAtMs };
}

describe('planSanityBatches', () => {
  it('audits nothing when every topic is behind the cursor', () => {
    const plan = planSanityBatches([topic('t1', 'f1', 'a', 100)], facts, 100);
    expect(plan.calls).toEqual([]);
    expect(plan.maxCreatedAtMs).toBe(0);
  });

  it('selects only topics newer than the cursor', () => {
    const plan = planSanityBatches(
      [topic('old', 'f1', 'a', 50), topic('new', 'f1', 'b', 150)],
      facts,
      100,
    );
    expect(plan.topicIdsByCallId.get('sanity:0')).toEqual(['new']);
  });

  it('orders oldest-first so the contaminated backlog drains first', () => {
    const plan = planSanityBatches(
      [topic('c', 'f1', 'c', 300), topic('a', 'f1', 'a', 100), topic('b', 'f1', 'b', 200)],
      facts,
      0,
    );
    expect(plan.topicIdsByCallId.get('sanity:0')).toEqual(['a', 'b', 'c']);
  });

  it('skips topics whose owning fact is missing', () => {
    const plan = planSanityBatches(
      [topic('t1', 'ghost', 'a', 100), topic('t2', 'f1', 'b', 200)],
      facts,
      0,
    );
    expect(plan.topicIdsByCallId.get('sanity:0')).toEqual(['t2']);
  });

  it('caps the sweep and chunks into batches', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      topic(`t${i}`, 'f1', `topic ${i}`, i + 1),
    );
    const plan = planSanityBatches(many, facts, 0, { batchSize: 15, maxTopics: 60 });

    expect(plan.calls).toHaveLength(4); // 60 / 15
    const audited = [...plan.topicIdsByCallId.values()].flat();
    expect(audited).toHaveLength(60);
    expect(audited[0]).toBe('t0'); // oldest first
  });

  it('reports the newest audited createdAt for the cursor', () => {
    const plan = planSanityBatches(
      [topic('a', 'f1', 'a', 100), topic('b', 'f1', 'b', 900)],
      facts,
      0,
    );
    expect(plan.maxCreatedAtMs).toBe(900);
  });

  it('does not advance the cursor past topics it did not audit', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      topic(`t${i}`, 'f1', `t ${i}`, (i + 1) * 100),
    );
    const plan = planSanityBatches(many, facts, 0, { batchSize: 2, maxTopics: 4 });
    // Audited the 4 oldest (100..400) — the cursor must stop there, not at 1000.
    expect(plan.maxCreatedAtMs).toBe(400);
  });

  it('enables thinking and sets the sanity budget on every call', () => {
    const plan = planSanityBatches([topic('t1', 'f1', 'a', 100)], facts, 0);
    for (const c of plan.calls) {
      expect(c.enableThinking).toBe(true);
      expect(c.maxTokens).toBe(SANITY_MAX_TOKENS);
      expect(c.temperature).toBe(0.1);
    }
  });
});

describe('renderSanityPrompt', () => {
  it('groups by fact but numbers items flat and 1-based', () => {
    const chunk = [
      topic('t1', 'f1', 'India cricket news', 1),
      topic('t2', 'f2', 'Bhopal healthcare', 2),
      topic('t3', 'f1', 'IPL rights', 3),
    ];
    const out = renderSanityPrompt(chunk, new Map(facts.map((f) => [f.id, f.statement])));

    // f1's two topics keep numbers 1 and 3 — the numbering follows the chunk,
    // not the grouping, so a verdict index maps straight back to a topic.
    expect(out).toContain('1. "India cricket news"');
    expect(out).toContain('3. "IPL rights"');
    expect(out).toContain('2. "Bhopal healthcare"');
    expect(out).toContain('Follows the Indian national cricket team');
    expect(out).toContain('Return exactly 3 verdicts.');
  });
});

describe('decodeSanityVerdicts', () => {
  const ids = ['t1', 't2', 't3'];

  it('flags only the explicit false verdicts', () => {
    const out = decodeSanityVerdicts(
      '[{"i":1,"ok":true},{"i":2,"ok":false},{"i":3,"ok":true}]',
      ids,
    );
    expect(out).toEqual(['t2']);
  });

  it('extracts the array from surrounding prose', () => {
    const out = decodeSanityVerdicts(
      'Here you go: [{"i":2,"ok":false}] hope that helps',
      ids,
    );
    expect(out).toEqual(['t2']);
  });

  describe('fail-safe: a bad response can never cause a retire', () => {
    const cases: [string, string][] = [
      ['unparseable', 'total nonsense'],
      ['not an array', '{"i":1,"ok":false}'],
      ['empty array', '[]'],
      ['index out of range', '[{"i":99,"ok":false}]'],
      ['index zero (1-based guard)', '[{"i":0,"ok":false}]'],
      ['negative index', '[{"i":-1,"ok":false}]'],
      ['non-integer index', '[{"i":1.5,"ok":false}]'],
      ['missing ok', '[{"i":1}]'],
      ['ok as string', '[{"i":1,"ok":"false"}]'],
      ['null entries', '[null,null]'],
    ];
    for (const [name, output] of cases) {
      it(`returns [] for ${name}`, () => {
        expect(decodeSanityVerdicts(output, ids)).toEqual([]);
      });
    }
  });

  it('ignores a truncated tail but keeps the verdicts it could read', () => {
    // A trace that overran leaves the array unclosed; the regex fallback fails
    // and nothing is flagged — a missed verdict, never a wrong retire.
    expect(decodeSanityVerdicts('[{"i":1,"ok":false},{"i":2,', ids)).toEqual([]);
  });

  it('deduplicates a repeated index', () => {
    expect(
      decodeSanityVerdicts('[{"i":2,"ok":false},{"i":2,"ok":false}]', ids),
    ).toEqual(['t2']);
  });

  it('warns through the injected logger on unparseable output', () => {
    const warn = jest.fn();
    const logger: HarnessLogger = { ...NOOP_LOGGER, warn };
    decodeSanityVerdicts('nonsense', ids, logger);
    expect(warn).toHaveBeenCalled();
  });
});
