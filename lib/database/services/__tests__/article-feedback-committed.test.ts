// F2/F3 — the COMMIT discriminator.
//
// `treePath` answers "where is the user in the tree", including branches they
// merely opened. `context_json.committed` answers "did a terminal leaf settle",
// and it is the only one a filled thumb may read. These tests pin that split,
// plus the two properties that make it safe: the flag is sticky, and it is never
// written as `false` (so an uncommitted row's snapshot is unchanged from before
// the field existed — which is what keeps the pre-existing suite green).
//
// Kept in its own file so `article-feedback-service.test.ts`, which asserts the
// UNCHANGED `processed_at` re-open rule, stays untouched.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), addBreadcrumb: jest.fn() },
}));

jest.mock('../persona-change-log-service', () => ({
  revertChange: jest.fn(async () => {}),
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import {
  getArticleVerdict,
  recordArticleFeedback,
  updateFeedbackContextPath,
} from '../article-feedback-service';

const db = database as any;
const NOW = 1700000000000;

function makeFeedbackRecord(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: `feedback_${Math.random().toString(36).slice(2)}`,
    articleId: 'a1',
    suggestionId: 'sugg-1',
    sentiment: 'dislike',
    title: 'Test Article',
    createdAt: new Date(NOW),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('article_feedback', []);
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('updateFeedbackContextPath — the committed flag', () => {
  it('does NOT mark a branch descent committed (F2: navigating is not voting)', async () => {
    const row = makeFeedbackRecord({ contextJson: '{"publication":"The Hindu"}' });
    db._setRows('article_feedback', [row]);

    await updateFeedbackContextPath('a1', 'dislike', ['not_important_to_me']);

    const snapshot = JSON.parse(row.contextJson);
    expect(snapshot.treePath).toEqual(['not_important_to_me']);
    expect(snapshot.committed).toBeUndefined();
    expect(await getArticleVerdict('a1')).toEqual({
      verdict: 'dislike',
      path: ['not_important_to_me'],
      committed: false,
    });
  });

  it('marks the row committed when a terminal leaf settles', async () => {
    const row = makeFeedbackRecord({ contextJson: '{"publication":"The Hindu"}' });
    db._setRows('article_feedback', [row]);

    await updateFeedbackContextPath('a1', 'dislike', ['not_important_to_me', 'not_important'], true);

    expect(JSON.parse(row.contextJson).committed).toBe(true);
    expect((await getArticleVerdict('a1')).committed).toBe(true);
  });

  it('is STICKY — walking back up the breadcrumb must not un-fill an applied leaf', async () => {
    const row = makeFeedbackRecord({ contextJson: '{"treePath":["x","y"],"committed":true}' });
    db._setRows('article_feedback', [row]);

    // A plain branch-descent write (committed omitted) after the commit.
    await updateFeedbackContextPath('a1', 'dislike', ['publication_content']);

    const snapshot = JSON.parse(row.contextJson);
    expect(snapshot.treePath).toEqual(['publication_content']);
    expect(snapshot.committed).toBe(true);
  });

  it('never writes committed:false — an uncommitted snapshot keeps its old shape', async () => {
    const row = makeFeedbackRecord({ contextJson: '{"relevance":0.5}' });
    db._setRows('article_feedback', [row]);

    await updateFeedbackContextPath('a1', 'dislike', ['n1'], false);

    expect(JSON.parse(row.contextJson)).toEqual({ relevance: 0.5, treePath: ['n1'] });
  });

  it('leaves the processed_at re-open rule alone (a part-way path stays digestible)', async () => {
    const row = makeFeedbackRecord({ contextJson: null, processedAt: NOW });
    db._setRows('article_feedback', [row]);

    await updateFeedbackContextPath('a1', 'dislike', ['not_important_to_me']);

    expect(row.processedAt).toBeNull();
  });
});

describe('getArticleVerdict — committed', () => {
  it('reports committed:false for a bare verdict', async () => {
    db._setRows('article_feedback', [makeFeedbackRecord({ contextJson: null })]);
    expect(await getArticleVerdict('a1')).toEqual({
      verdict: 'dislike',
      path: [],
      committed: false,
    });
  });

  it('reports committed:false for corrupt json rather than throwing', async () => {
    db._setRows('article_feedback', [makeFeedbackRecord({ contextJson: '{not json' })]);
    expect((await getArticleVerdict('a1')).committed).toBe(false);
  });
});

describe('recordArticleFeedback — reap-at-write is unchanged', () => {
  it('still stamps a context-less verdict processed at write', async () => {
    let captured: any;
    db._collections.article_feedback.create.mockImplementation((fn: any) => {
      captured = {};
      fn(captured);
      return Promise.resolve(captured);
    });

    await recordArticleFeedback({
      articleId: 'a1',
      sentiment: 'dislike',
      title: 'T',
      contextJson: '{"publication":"X"}',
    });

    expect(captured.processedAt).toBe(NOW);
  });
});
