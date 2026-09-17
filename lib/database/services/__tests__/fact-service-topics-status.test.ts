/**
 * v55 additions to fact-service: the status accessors, the live observables,
 * replaceFact, and the widened rescue sweep.
 */
jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), captureException: jest.fn(), error: jest.fn() },
}));
const mockPurge = jest.fn(async (..._a: unknown[]) => 0);
jest.mock('../article-suggestion-service', () => ({
  purgeSuggestionsForDeadTopics: (...a: unknown[]) => mockPurge(...a),
}));
jest.mock('../topic-service', () => ({
  getAllTopicIds: jest.fn(async () => new Set<string>()),
  normalizeTopicText: (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' '),
}));
const mockGetActiveTopicGenFactIds = jest.fn(async () => new Set<string>());
jest.mock('../inference-job-service', () => ({
  getActiveTopicGenFactIds: (...a: unknown[]) => mockGetActiveTopicGenFactIds(...(a as [])),
}));

import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';
import {
  addFact,
  markOrphanedFactsAsFailed,
  replaceFact,
  removeFactMetadataTopics,
  getTopicsStatus,
  PENDING_TOPICS_STALE_MS,
} from '../fact-service';

const db = database as unknown as MockDatabase;
const STALE = new Date(Date.now() - PENDING_TOPICS_STALE_MS - 1_000);
const FRESH = new Date();
const NOW = new Date('2026-01-01T00:00:00.000Z');

/** Real WatermelonDB sets createdAt/updatedAt from the @date decorators; the
 *  shared mock's bare record does not, and `toFact` reads them. Same stub the
 *  existing fact-service suite uses. */
function stubDatedCreate(table: 'facts') {
  const col = db._collections[table];
  col.create = jest.fn(async (fn: (r: any) => void) => {
    const rec = makeRecord({ createdAt: NOW, updatedAt: NOW });
    fn(rec);
    col._rows.push(rec);
    return rec;
  });
  col.prepareCreate = jest.fn((fn: (r: any) => void) => {
    const rec = makeRecord({ createdAt: NOW, updatedAt: NOW });
    fn(rec);
    return rec;
  });
  return col;
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('facts', []);
  db._setRows('topics', []);
  stubDatedCreate('facts');
});

describe('addFact topicsStatus opt-in', () => {
  it('leaves the column NULL by default', async () => {
    await addFact('I live in Rotterdam');
    const created = db._collections['facts']._rows[0];
    expect(created.topicsStatus).toBeUndefined();
  });

  it('stamps pending when the caller IS enqueuing generation', async () => {
    await addFact('I live in Rotterdam', undefined, undefined, { topicsStatus: 'pending' });
    const created = db._collections['facts']._rows[0];
    expect(created.topicsStatus).toBe('pending');
    expect(created.topicsUpdatedAt).toBeInstanceOf(Date);
  });
});

describe('the rescue sweep', () => {
  it('needs BOTH no live job AND staleness before it calls a pending fact dead', async () => {
    // A fact enqueued milliseconds before a foreground would otherwise lose
    // the race between the enqueue write and this read.
    const fresh = makeRecord({
      id: 'f1',
      topicsStatus: 'pending',
      topicsUpdatedAt: FRESH,
      metadata: {},
    });
    db._setRows('facts', [fresh]);

    expect(await markOrphanedFactsAsFailed(new Set(), 'dead')).toBe(0);
    expect(fresh.topicsStatus).toBe('pending');
  });

  it('leaves a pending fact alone while its job is still QUEUED', async () => {
    const rec = makeRecord({
      id: 'f1',
      topicsStatus: 'pending',
      topicsUpdatedAt: STALE,
      metadata: {},
    });
    db._setRows('facts', [rec]);

    expect(await markOrphanedFactsAsFailed(new Set(['f1']), 'dead')).toBe(0);
    expect(rec.topicsStatus).toBe('pending');
  });

  it('errors a stale pending fact that owns NO topics, writing column AND marker', async () => {
    const rec = makeRecord({
      id: 'f1',
      topicsStatus: 'pending',
      topicsUpdatedAt: STALE,
      metadata: {},
    });
    db._setRows('facts', [rec]);

    expect(await markOrphanedFactsAsFailed(new Set(), 'dead')).toBe(1);
    expect(rec.topicsStatus).toBe('error');
    expect(rec.metadata.topicGenError).toEqual(['dead']);
  });

  it('HEALS a stale pending fact that already owns topics to done, not error', async () => {
    // completeTopicGeneration minted and died before stamping. That is a
    // cosmetic spinner, and escalating it to a user-visible error would be
    // wrong — this is what makes the mint-then-stamp ordering safe.
    const rec = makeRecord({
      id: 'f1',
      topicsStatus: 'pending',
      topicsUpdatedAt: STALE,
      metadata: { topics: ['Dutch Politics'] },
    });
    db._setRows('facts', [rec]);

    expect(await markOrphanedFactsAsFailed(new Set(), 'dead')).toBe(1);
    expect(rec.topicsStatus).toBe('done');
    expect(rec.metadata.topicGenError).toBeUndefined();
  });

  it('still handles the legacy no-topics-no-error row with no status', async () => {
    const rec = makeRecord({ id: 'f1', topicsStatus: null, metadata: {} });
    db._setRows('facts', [rec]);
    expect(await markOrphanedFactsAsFailed(new Set(), 'dead')).toBe(1);
    expect(rec.metadata.topicGenError).toEqual(['dead']);
  });
});

describe('replaceFact', () => {
  it('destroys the old fact AND its topics and creates the new one in ONE batch', async () => {
    const old = makeRecord({ id: 'old', statement: 'I live in Berlin' });
    db._setRows('facts', [old]);
    const topic = makeRecord({ id: 't1', factId: 'old' });
    db._setRows('topics', [topic]);

    const result = await replaceFact('old', { statement: 'I live in Rotterdam' });

    expect(old.prepareDestroyPermanently).toHaveBeenCalled();
    expect(topic.prepareDestroyPermanently).toHaveBeenCalled();
    expect(result.statement).toBe('I live in Rotterdam');
    // Atomic: a kill mid-write yields both or neither, never a user left with
    // the old fact gone and nothing in its place.
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(db.write).toHaveBeenCalledTimes(1);
  });

  it('defaults the replacement to pending — it needs new topics by construction', async () => {
    db._setRows('facts', [makeRecord({ id: 'old' })]);
    const result = await replaceFact('old', { statement: 'new' });
    expect(result.topicsStatus).toBe('pending');
  });

  it('purges suggestions the destroyed topics had retrieved', async () => {
    db._setRows('facts', [makeRecord({ id: 'old' })]);
    db._setRows('topics', [makeRecord({ id: 't1', factId: 'old' })]);
    await replaceFact('old', { statement: 'new' });
    expect(mockPurge).toHaveBeenCalledTimes(1);
  });

  it('a missing oldId still creates the new fact rather than throwing', async () => {
    // The caller is an LLM-driven path; a stale `replaces` id is realistic.
    const result = await replaceFact('ghost', { statement: 'new' });
    expect(result.statement).toBe('new');
  });
});

describe('removeFactMetadataTopics', () => {
  it('prunes by the normalised key and preserves sibling metadata', async () => {
    const rec = makeRecord({
      id: 'f1',
      statement: 's',
      metadata: {
        topics: ['Dutch  Politics', 'Cycling'],
        topicGenError: ['boom'],
      },
      updateFact: jest.fn(async function (this: any, _s: string, meta: any) {
        rec.metadata = meta;
      }),
    });
    db._setRows('facts', [rec]);

    await removeFactMetadataTopics('f1', ['dutch politics']);

    expect(rec.metadata.topics).toEqual(['Cycling']);
    expect(rec.metadata.topicGenError).toEqual(['boom']);
  });

  it('is a no-op when nothing matches, and on a missing fact', async () => {
    const rec = makeRecord({
      id: 'f1',
      metadata: { topics: ['Cycling'] },
      updateFact: jest.fn(),
    });
    db._setRows('facts', [rec]);
    await removeFactMetadataTopics('f1', ['nope']);
    expect(rec.updateFact).not.toHaveBeenCalled();
    await expect(removeFactMetadataTopics('ghost', ['x'])).resolves.toBeUndefined();
  });
});

describe('getTopicsStatus', () => {
  it('returns the stored status, and null for a missing fact', async () => {
    db._setRows('facts', [makeRecord({ id: 'f1', topicsStatus: 'error' })]);
    expect(await getTopicsStatus('f1')).toBe('error');
    expect(await getTopicsStatus('ghost')).toBeNull();
  });
});
