jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});
jest.mock('@/lib/database/services/user-publication-subscription-service', () => ({
  getSubscribedSourceNameSet: jest.fn(async () => new Set(['het parool'])),
}));
jest.mock('@/lib/database/services/subscribed-sibling-service', () => ({
  findPrimarySubscribedSibling: jest.fn(),
  saveSubscriptionRead: jest.fn(async () => undefined),
}));
jest.mock('../stage-scoring', () => ({ getScoringLlmPort: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), captureException: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';
import {
  findPrimarySubscribedSibling,
  saveSubscriptionRead,
} from '@/lib/database/services/subscribed-sibling-service';
import { getSubscribedSourceNameSet } from '@/lib/database/services/user-publication-subscription-service';

import { getScoringLlmPort } from '../stage-scoring';
import { runSubscriptionReadStage } from '../stage-subscription-read';

const TABLE = 'article_suggestions';
const db = database as unknown as MockDatabase;

function anchorRow(over: Record<string, any> = {}) {
  return makeRecord({
    id: over.id ?? 'anchor',
    titleEn: 'Cabinet falls over nitrogen plan',
    titleOriginal: null,
    subscriptionReadAt: null,
    subscriptionRead: null,
    ...over,
  });
}

function siblingRow(over: Record<string, any> = {}) {
  return makeRecord({
    id: 'sib',
    publicationName: 'Het Parool',
    titleEn: 'Coalition talks collapse',
    titleOriginal: null,
    descriptionEn: 'The coalition failed to agree on nitrogen limits.',
    category: 'politics',
    eventType: null,
    ...over,
  });
}

const complete = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows(TABLE, []);
  (getScoringLlmPort as jest.Mock).mockReturnValue({ complete, batchComplete: jest.fn() });
  (getSubscribedSourceNameSet as jest.Mock).mockResolvedValue(new Set(['het parool']));
});

describe('runSubscriptionReadStage', () => {
  // The overwhelmingly common case. It must cost nothing.
  it('exits immediately and touches no table when nothing is subscribed', async () => {
    (getSubscribedSourceNameSet as jest.Mock).mockResolvedValue(new Set());
    db._setRows(TABLE, [anchorRow()]);

    expect(await runSubscriptionReadStage()).toBe(0);
    expect(db._collections[TABLE].query).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('writes a read for a row with a subscribed sibling', async () => {
    const anchor = anchorRow();
    db._setRows(TABLE, [anchor]);
    (findPrimarySubscribedSibling as jest.Mock).mockResolvedValue(siblingRow());
    complete.mockResolvedValue('Focuses on the coalition talks rather than the farmers.');

    expect(await runSubscriptionReadStage()).toBe(1);
    expect(saveSubscriptionRead).toHaveBeenCalledWith(
      'anchor',
      'Focuses on the coalition talks rather than the farmers.',
    );
  });

  it('does nothing for a row with no subscribed sibling', async () => {
    db._setRows(TABLE, [anchorRow()]);
    (findPrimarySubscribedSibling as jest.Mock).mockResolvedValue(null);

    expect(await runSubscriptionReadStage()).toBe(0);
    expect(saveSubscriptionRead).not.toHaveBeenCalled();
  });

  // A SKIP is a real answer and must be stamped, or the row is re-asked on
  // every sync for the rest of its 48 hours.
  it('stamps a SKIP so the row is never re-asked, but counts no read', async () => {
    db._setRows(TABLE, [anchorRow()]);
    (findPrimarySubscribedSibling as jest.Mock).mockResolvedValue(siblingRow());
    complete.mockResolvedValue('SKIP');

    expect(await runSubscriptionReadStage()).toBe(0);
    expect(saveSubscriptionRead).toHaveBeenCalledWith('anchor', '');
  });

  it('stamps an empty model response the same way', async () => {
    db._setRows(TABLE, [anchorRow()]);
    (findPrimarySubscribedSibling as jest.Mock).mockResolvedValue(siblingRow());
    complete.mockResolvedValue('   ');

    expect(await runSubscriptionReadStage()).toBe(0);
    expect(saveSubscriptionRead).toHaveBeenCalledWith('anchor', '');
  });

  it('skips rows that already carry a read timestamp', async () => {
    db._setRows(TABLE, [anchorRow({ subscriptionReadAt: 123 })]);
    expect(await runSubscriptionReadStage()).toBe(0);
    expect(findPrimarySubscribedSibling).not.toHaveBeenCalled();
  });

  it('honours the per-run cap', async () => {
    db._setRows(TABLE, [
      anchorRow({ id: 'a' }),
      anchorRow({ id: 'b' }),
      anchorRow({ id: 'c' }),
    ]);
    (findPrimarySubscribedSibling as jest.Mock).mockResolvedValue(siblingRow());
    complete.mockResolvedValue('A read.');

    expect(await runSubscriptionReadStage(2)).toBe(2);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  // One bad row must not cost the whole pass.
  it('continues past a row whose model call throws', async () => {
    db._setRows(TABLE, [anchorRow({ id: 'a' }), anchorRow({ id: 'b' })]);
    (findPrimarySubscribedSibling as jest.Mock).mockResolvedValue(siblingRow());
    complete.mockRejectedValueOnce(new Error('boom')).mockResolvedValue('A read.');

    expect(await runSubscriptionReadStage()).toBe(1);
  });

  // This runs on the sync path. It must never throw upward.
  it('returns 0 rather than throwing when the whole stage fails', async () => {
    (getSubscribedSourceNameSet as jest.Mock).mockRejectedValue(new Error('db gone'));
    await expect(runSubscriptionReadStage()).resolves.toBe(0);
  });

  describe('the prompt', () => {
    beforeEach(async () => {
      db._setRows(TABLE, [anchorRow()]);
      (findPrimarySubscribedSibling as jest.Mock).mockResolvedValue(siblingRow());
      complete.mockResolvedValue('A read.');
      await runSubscriptionReadStage();
    });

    // The single most important property of this whole stage: the body is
    // paywalled, we never fetch it, and nothing may imply otherwise.
    it('tells the model it has NOT been given the full article', () => {
      const { systemPrompt } = complete.mock.calls[0][0];
      expect(systemPrompt).toContain('You have NOT been given the full article');
      expect(systemPrompt).toContain('Never claim or imply you read the full article');
    });

    it('offers SKIP as the answer for thin input', () => {
      expect(complete.mock.calls[0][0].systemPrompt).toContain('SKIP');
    });

    it('sends only the headline, description and existing enrichment', () => {
      const { prompt } = complete.mock.calls[0][0];
      expect(prompt).toContain('Coalition talks collapse');
      expect(prompt).toContain('The coalition failed to agree on nitrogen limits.');
      expect(prompt).toContain('Het Parool');
    });

    it('runs at temperature 0 so the same inputs give the same read', () => {
      expect(complete.mock.calls[0][0].temperature).toBe(0);
    });
  });
});
