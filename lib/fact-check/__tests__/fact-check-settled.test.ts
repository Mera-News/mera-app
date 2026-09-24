// The ONE place a settled fact check is noticed. Every case here is about
// "only once, and only for a check this device asked for".

const mockSettings = new Map<string, string>();
jest.mock('../../database/services/setting-service', () => ({
  getSetting: async (k: string) => mockSettings.get(k) ?? null,
  setSetting: async (k: string, v: string) => { mockSettings.set(k, v); },
}));
const mockNotified = jest.fn();
jest.mock('../../toast-manager', () => ({
  toastManager: { showNotifiedToast: (...a: unknown[]) => mockNotified(...a) },
}));
jest.mock('../../logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

import {
  ASKED_TTL_MS,
  listAskedFactChecks,
  noteFactCheckStored,
  outcomeFor,
  recordFactCheckAsked,
} from '../fact-check-settled';
import type { FactCheckRow } from '../fact-check-types';

const row = (over: Partial<FactCheckRow> = {}): FactCheckRow =>
  ({
    _id: 'fc1',
    status: 'complete',
    verdict: null,
    checkedBy: [],
    checkedByStatus: 'searched',
    articleTitle: 'A headline',
    ...over,
  }) as unknown as FactCheckRow;

beforeEach(() => {
  mockSettings.clear();
  mockNotified.mockClear();
});

describe('noteFactCheckStored', () => {
  it('notifies once when an asked check goes from waiting to settled', async () => {
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: 's1', title: 'Fallback' });
    expect(await noteFactCheckStored('a1', 'pending', row())).toBe(true);
    // The same change seen by a second path (panel poll, mirror, re-read).
    expect(await noteFactCheckStored('a1', 'pending', row())).toBe(false);
    expect(mockNotified).toHaveBeenCalledTimes(1);
    expect(mockNotified.mock.calls[0][0]).toEqual({
      type: 'fact_check_done',
      source: 'fact-check',
      title: 'factCheck.notify.title',
      body: 'factCheck.notify.bodyNone',
      icon: 'fact-check',
      context: { articleId: 'a1', suggestionId: 's1', articleTitle: 'A headline', outcome: 'none', title: 'A headline' },
      actions: [{ id: 'open-fact-check', labelKey: 'factCheck.notify.open' }],
    });
  });

  // A body with {{title}} and no title to put in it would read 'for ""'.
  // It takes the body key written without the placeholder instead.
  it.each([
    ['none', {}, 'factCheck.notify.bodyNoneUntitled'],
    ['unavailable', { checkedByStatus: 'unavailable' }, 'factCheck.notify.bodyUnavailableUntitled'],
  ] as const)('with no title at all, the %s outcome uses the untitled body', async (_o, over, key) => {
    await recordFactCheckAsked({ articleId: 'a9', suggestionId: null, title: null });
    expect(await noteFactCheckStored('a9', 'pending', row({ articleTitle: null as any, ...over }))).toBe(true);
    expect(mockNotified.mock.calls[0][0].body).toBe(key);
  });

  it('never notifies for a check this device did not ask for', async () => {
    // fact_checks also holds checks mirrored from other readers' articles.
    expect(await noteFactCheckStored('a2', 'pending', row())).toBe(false);
    expect(mockNotified).not.toHaveBeenCalled();
  });

  it('does not notify for an answer that was already there on the first ask', async () => {
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: null });
    expect(await noteFactCheckStored('a1', null, row())).toBe(false);
    expect(mockNotified).not.toHaveBeenCalled();
    // ...and the ask is spent, so a later store cannot notify for it either.
    expect(await listAskedFactChecks()).toEqual([]);
  });

  it('waits while the check is still running', async () => {
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: null });
    expect(await noteFactCheckStored('a1', 'pending', row({ status: 'running' }))).toBe(false);
    expect((await listAskedFactChecks()).map((a) => a.articleId)).toEqual(['a1']);
  });

  it('cuts a long title for the notification body only', async () => {
    const long = 'x'.repeat(90);
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: null });
    await noteFactCheckStored('a1', 'failed', row({ articleTitle: long }));
    const ctx = mockNotified.mock.calls[0][0].context;
    expect(ctx.articleTitle).toBe(long);
    expect(ctx.title.length).toBe(60);
    expect(ctx.suggestionId).toBeUndefined();
  });
});

describe('outcomeFor', () => {
  it('maps the external-checks line onto three bodies', () => {
    expect(outcomeFor(row({ checkedBy: [{ organisation: 'Snopes', url: null, verdict: null, summary: null }] as never }))).toBe('found');
    expect(outcomeFor(row())).toBe('none');
    expect(outcomeFor(row({ checkedByStatus: 'unavailable' as never }))).toBe('unavailable');
    expect(outcomeFor(row({ status: 'blocked' }))).toBe('unavailable');
  });
});

describe('the asked list', () => {
  it('survives a reload because it is persisted, and drops asks past their age', async () => {
    await recordFactCheckAsked({ articleId: 'old', suggestionId: null, title: null }, 0);
    await recordFactCheckAsked({ articleId: 'new', suggestionId: null, title: null }, ASKED_TTL_MS);
    const now = ASKED_TTL_MS + 1000;
    expect((await listAskedFactChecks(now)).map((a) => a.articleId)).toEqual(['new']);
  });
});
