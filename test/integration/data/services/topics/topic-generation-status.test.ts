// The three verbs that move `facts.topics_status`, the queue's view of which facts still have a
// generation job, and the rescue sweep that must never error a fact that is only waiting its turn.
// Real facts, topics and `inference_jobs` rows; faults are key-scoped batch failures (R26).
//
// Replaces topic-generation-status-service.test.ts (all 12 `it`): begin stamps pending in one
// write; begin skips a missing fact; begin writes nothing for an empty list; complete MINTS BEFORE
// IT STAMPS; a mint that throws leaves the status pending; minting goes through createTopics (dedup
// floor and metadata pairing); done with no usable texts; fail writes the column and the legacy
// marker; fail on a missing fact; minted topics have a non-zero weight; minted topics are
// llm-provenance and active.
//
// Not carried over: "`createTopics` was called with a list holding one entry" and the call-order
// array assert a mock. The order is now observed through the two failure modes, which end in
// different states: a failing mint leaves the fact pending with no rows, a failing stamp leaves the
// rows and the fact pending.
import {
  addFact,
  getFacts,
  getTopicsStatus,
  markOrphanedFactsAsFailed,
  rescueStalePendingTopicFacts,
} from '@/lib/database/services/fact-service';
import {
  dequeueJob,
  enqueueJob,
  getActiveTopicGenFactIds,
} from '@/lib/database/services/inference-job-service';
import * as statusService from '@/lib/database/services/topic-generation-status-service';
import {
  beginTopicGeneration,
  completeTopicGeneration,
  failTopicGeneration,
  markTopicGenerationSettled,
} from '@/lib/database/services/topic-generation-status-service';
import { getByFact } from '@/lib/database/services/topic-service';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { useFakeClock } from '@/test/helpers';

import {
  cleanupTopics,
  countRows,
  failBatchWhere,
  metadataOf,
  metadataTopics,
  persistedTopicsStatus,
  resetTopicsMemory,
} from './support';

beforeEach(resetTopicsMemory);
afterEach(cleanupTopics);

describe('the public surface', () => {
  it('exports no bare setter: begin, complete, fail and settle are the only writers of topics_status', () => {
    expect(Object.keys(statusService).sort()).toEqual([
      'beginTopicGeneration',
      'completeTopicGeneration',
      'failTopicGeneration',
      'markTopicGenerationSettled',
    ]);
  });
});

describe('beginTopicGeneration', () => {
  it('stamps pending on every fact', async () => {
    const a = await addFact('Follows chess');
    const b = await addFact('Follows cycling');

    await beginTopicGeneration([a.id, b.id]);

    expect(await getTopicsStatus(a.id)).toBe('pending');
    expect(await getTopicsStatus(b.id)).toBe('pending');
    const stamped = (await getFacts()).filter((f) => f.topicsStatus === 'pending');
    expect(stamped.every((f) => f.topicsUpdatedAt !== null)).toBe(true);
  });

  it('is ONE write for the whole set: a failure on the second fact leaves the first unstamped too', async () => {
    const a = await addFact('Follows chess');
    const b = await addFact('Follows cycling');
    failBatchWhere((op) => op.table === 'facts' && op.raw.id === b.id);

    await expect(beginTopicGeneration([a.id, b.id])).rejects.toThrow('batch failed (injected)');

    expect(await persistedTopicsStatus(a.id)).toBeNull();
    expect(await persistedTopicsStatus(b.id)).toBeNull();
  });

  it('skips a fact deleted between enqueue and stamp without failing the batch', async () => {
    const a = await addFact('Follows chess');

    await beginTopicGeneration([a.id, 'ghost']);

    expect(await getTopicsStatus(a.id)).toBe('pending');
  });

  it('writes nothing for an empty list', async () => {
    const a = await addFact('Follows chess');
    await beginTopicGeneration([]);
    expect(await getTopicsStatus(a.id)).toBeNull();
  });
});

describe('completeTopicGeneration: mint, THEN stamp', () => {
  it('mints trimmed texts as active, weighted, llm-provenance rows, keeps the metadata list in step, and stamps done', async () => {
    const fact = await addFact('Follows Dutch life');
    await beginTopicGeneration([fact.id]);

    const minted = await completeTopicGeneration(fact.id, [' Dutch Politics ', '', '  ', 'Amsterdam housing']);

    expect(minted.map((t) => t.text)).toEqual(['Dutch Politics', 'Amsterdam housing']);
    const rows = await getByFact(fact.id);
    expect(rows.map((t) => [t.text, t.status, t.provenance, t.highPriority, t.factId]).sort()).toEqual([
      ['Amsterdam housing', 'active', 'llm', false, fact.id],
      ['Dutch Politics', 'active', 'llm', false, fact.id],
    ]);
    // Retrievable: a weight <= 0 is a topic the feed query never asks about.
    for (const t of rows) expect(t.weight).toBe(DEFAULT_HARNESS_CONFIG.topicGen.llmTopicWeight);
    expect(await metadataTopics(fact.id)).toEqual(['Dutch Politics', 'Amsterdam housing']);
    expect(await getTopicsStatus(fact.id)).toBe('done');
  });

  it('mints through createTopics, so running it twice leaves one row per text', async () => {
    const fact = await addFact('Follows Dutch life');

    await completeTopicGeneration(fact.id, ['Dutch Politics']);
    const again = await completeTopicGeneration(fact.id, ['dutch  politics']);

    expect(await getByFact(fact.id)).toHaveLength(1);
    expect(again).toHaveLength(1);
    expect(await metadataTopics(fact.id)).toEqual(['Dutch Politics']);
  });

  it('still stamps done when there were no usable texts, and mints nothing', async () => {
    const fact = await addFact('Follows Dutch life');
    await beginTopicGeneration([fact.id]);

    expect(await completeTopicGeneration(fact.id, ['', '   '])).toEqual([]);

    expect(await getByFact(fact.id)).toEqual([]);
    expect(await getTopicsStatus(fact.id)).toBe('done');
  });

  it('a mint that throws leaves the status at pending and no rows: nothing is stamped done over an empty fact', async () => {
    const fact = await addFact('Follows Dutch life');
    await beginTopicGeneration([fact.id]);
    failBatchWhere((op) => op.table === 'topics');

    await expect(completeTopicGeneration(fact.id, ['Dutch Politics'])).rejects.toThrow('batch failed (injected)');

    expect(await countRows('topics')).toBe(0);
    expect(await persistedTopicsStatus(fact.id)).toBe('pending');
  });

  it('a stamp that throws AFTER the mint leaves the topics in place and the status pending (healed by the rescue sweep)', async () => {
    const fact = await addFact('Follows Dutch life');
    await beginTopicGeneration([fact.id]);
    failBatchWhere((op) => op.table === 'facts' && op.raw.topics_status === 'done');

    const minted = await completeTopicGeneration(fact.id, ['Dutch Politics']);

    expect(minted).toHaveLength(1);
    expect(await countRows('topics')).toBe(1);
    expect(await persistedTopicsStatus(fact.id)).toBe('pending');
  });
});

describe('markTopicGenerationSettled', () => {
  it('stamps done without minting, and skips a missing fact', async () => {
    const fact = await addFact('Follows Dutch life');
    await beginTopicGeneration([fact.id]);

    await markTopicGenerationSettled([fact.id, 'ghost']);

    expect(await getTopicsStatus(fact.id)).toBe('done');
    expect(await countRows('topics')).toBe(0);
  });
});

describe('failTopicGeneration', () => {
  it('writes the column AND the legacy marker, keeping the sibling metadata', async () => {
    const fact = await addFact('Follows Dutch life', { topics: ['keep'] });
    await beginTopicGeneration([fact.id]);

    await failTopicGeneration(fact.id, 'the model fell over');

    expect(await getTopicsStatus(fact.id)).toBe('error');
    expect(await metadataOf(fact.id)).toEqual({ topics: ['keep'], topicGenError: ['the model fell over'] });
  });

  it('a missing fact is a logged no-op, not a throw', async () => {
    await expect(failTopicGeneration('ghost', 'x')).resolves.toBeUndefined();
  });
});

describe('getActiveTopicGenFactIds: pending and running, topic_gen only', () => {
  it('matches queued and running jobs, and not finished jobs or other job types', async () => {
    // running
    await enqueueJob('topic_gen', { factId: 'f-running' });
    await (await dequeueJob())!.markRunning();
    // finished
    await enqueueJob('topic_gen', { factId: 'f-done' });
    const finished = (await dequeueJob())!;
    await finished.markRunning();
    await finished.markDone({ topics: [] });
    // queued
    await enqueueJob('topic_gen', { factId: 'f-queued' });
    // not topic_gen
    await enqueueJob('topic_combo', { factId: 'f-combo', passId: 'p1' });
    await enqueueJob('persona_summary', { factId: 'f-summary' });

    expect(await getActiveTopicGenFactIds()).toEqual(new Set(['f-running', 'f-queued']));
  });
});

describe('a fact waiting behind the queue is never stamped error', () => {
  const T0 = '2026-10-09T10:00:00Z';
  const STALE_MS = 11 * 60 * 1000;

  it('a stale pending fact whose job is still queued is left alone; once the job is gone it errors', async () => {
    useFakeClock(T0);
    const fact = await addFact('Follows chess');
    await beginTopicGeneration([fact.id]);
    await enqueueJob('topic_gen', { factId: fact.id, factStatement: 'Follows chess' });
    jest.setSystemTime(Date.parse(T0) + STALE_MS);

    expect(await rescueStalePendingTopicFacts()).toBe(0);
    expect(await getTopicsStatus(fact.id)).toBe('pending');
    expect((await metadataOf(fact.id)).topicGenError).toBeUndefined();

    // The job finishes (or dies): nothing waits for this fact any more.
    const job = (await dequeueJob())!;
    await job.markRunning();
    await job.markDone({ topics: [] });

    expect(await rescueStalePendingTopicFacts()).toBe(1);
    expect(await getTopicsStatus(fact.id)).toBe('error');
    expect((await metadataOf(fact.id)).topicGenError).toEqual(['Topic generation failed — please delete and retry.']);
  });

  it('the active-fact set is what the sweep honours: a pending fact in it is skipped however stale', async () => {
    useFakeClock(T0);
    const fact = await addFact('Follows chess');
    await beginTopicGeneration([fact.id]);
    jest.setSystemTime(Date.parse(T0) + STALE_MS);

    expect(await markOrphanedFactsAsFailed(new Set([fact.id]), 'dead')).toBe(0);
    expect(await getTopicsStatus(fact.id)).toBe('pending');
    expect(await markOrphanedFactsAsFailed(new Set(), 'dead')).toBe(1);
    expect(await getTopicsStatus(fact.id)).toBe('error');
  });
});
