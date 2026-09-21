/**
 * The three verbs that move `facts.topics_status`.
 *
 * The property that matters most here is ORDER: completeTopicGeneration must
 * mint BEFORE it stamps. Asserting only the end state cannot tell the two
 * orderings apart, and the wrong one fails invisibly and permanently.
 */
jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), captureException: jest.fn(), error: jest.fn() },
}));
const mockCreateTopics = jest.fn(async (..._a: unknown[]) => []);
jest.mock('../topic-service', () => ({
  createTopics: (...a: unknown[]) => mockCreateTopics(...a),
}));

import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';
import {
  beginTopicGeneration,
  completeTopicGeneration,
  failTopicGeneration,
} from '../topic-generation-status-service';

const db = database as unknown as MockDatabase;

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('facts', []);
});

describe('beginTopicGeneration', () => {
  it('stamps pending on every fact in ONE write', async () => {
    const a = makeRecord({ id: 'f1' });
    const b = makeRecord({ id: 'f2' });
    db._setRows('facts', [a, b]);

    await beginTopicGeneration(['f1', 'f2']);

    expect(a.topicsStatus).toBe('pending');
    expect(b.topicsStatus).toBe('pending');
    // One transaction for one logical event, not N.
    expect(db.write).toHaveBeenCalledTimes(1);
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it('skips a fact deleted between enqueue and stamp without failing the batch', async () => {
    const a = makeRecord({ id: 'f1' });
    db._setRows('facts', [a]);
    await beginTopicGeneration(['f1', 'ghost']);
    expect(a.topicsStatus).toBe('pending');
  });

  it('writes nothing for an empty list', async () => {
    await beginTopicGeneration([]);
    expect(db.write).not.toHaveBeenCalled();
  });
});

describe('completeTopicGeneration', () => {
  it('MINTS BEFORE IT STAMPS', async () => {
    // Order, not end state. Stamp-first + a mint throw leaves 'done' with no
    // topics and nothing to retry: invisible and permanent. Mint-first +
    // a stamp throw leaves a cosmetic spinner the rescue sweep heals.
    const order: string[] = [];
    mockCreateTopics.mockImplementationOnce(async () => {
      order.push('mint');
      return [];
    });
    const fact = makeRecord({
      id: 'f1',
      setTopicsStatus: jest.fn(async () => {
        order.push('stamp');
      }),
    });
    db._setRows('facts', [fact]);

    await completeTopicGeneration('f1', ['Dutch Politics']);

    expect(order).toEqual(['mint', 'stamp']);
  });

  it('leaves the status at pending when minting throws', async () => {
    mockCreateTopics.mockRejectedValueOnce(new Error('boom'));
    const fact = makeRecord({ id: 'f1', topicsStatus: 'pending', setTopicsStatus: jest.fn() });
    db._setRows('facts', [fact]);

    await expect(completeTopicGeneration('f1', ['X'])).rejects.toThrow('boom');
    expect(fact.setTopicsStatus).not.toHaveBeenCalled();
    expect(fact.topicsStatus).toBe('pending');
  });

  it('mints through createTopics, so the dedup floor and metadata pairing apply', async () => {
    const fact = makeRecord({ id: 'f1', setTopicsStatus: jest.fn() });
    db._setRows('facts', [fact]);

    await completeTopicGeneration('f1', [' Dutch Politics ', '', '  ']);

    // Blanks dropped, texts trimmed, each carrying the factId that drives the
    // metadata pairing inside createTopics.
    expect(mockCreateTopics).toHaveBeenCalledWith([
      { factId: 'f1', text: 'Dutch Politics' },
    ]);
  });

  it('still stamps done when there were no usable texts', async () => {
    const fact = makeRecord({ id: 'f1', setTopicsStatus: jest.fn() });
    db._setRows('facts', [fact]);
    await completeTopicGeneration('f1', []);
    expect(mockCreateTopics).not.toHaveBeenCalled();
    expect(fact.setTopicsStatus).toHaveBeenCalledWith('done');
  });
});

describe('failTopicGeneration', () => {
  it('writes the column AND the legacy marker in one write', async () => {
    // Three live components still read metadata.topicGenError and are not
    // this area's to change; writing only one of the two would let them
    // disagree about the same run.
    const fact = makeRecord({ id: 'f1', metadata: { topics: ['keep'] } });
    db._setRows('facts', [fact]);

    await failTopicGeneration('f1', 'the model fell over');

    expect(fact.topicsStatus).toBe('error');
    expect(fact.metadata.topicGenError).toEqual(['the model fell over']);
    // The wholesale-assign trap: siblings survive.
    expect(fact.metadata.topics).toEqual(['keep']);
    expect(db.write).toHaveBeenCalledTimes(1);
  });

  it('a missing fact is a logged no-op, not a throw', async () => {
    await expect(failTopicGeneration('ghost', 'x')).resolves.toBeUndefined();
    expect(db.write).not.toHaveBeenCalled();
  });
});
