// Structured "not interested" filters at the executor seam (P3).
//
// Covers what persona-action-executor.test.ts deliberately does not: the v46
// kind/value passthrough, the row-source fix, the new retire_suppression case,
// and — the part that is easy to get silently wrong — WHICH action/condition
// pairs run WHICH retroactive sweep (D12) and which mark the feed dirty (D18).
// Every collaborator is mocked; this is a dispatch test, not a DB test.

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(() => 'evt') },
}));

jest.mock('../topic-service', () => ({
  createTopics: jest.fn(async () => [{ id: 't-new' }]),
  retire: jest.fn(async () => {}),
}));

jest.mock('../suppression-service', () => ({
  addSuppression: jest.fn(async () => ({ id: 'sup-1' })),
  getAll: jest.fn(async () => []),
  retireSuppression: jest.fn(async () => {}),
  kindOf: jest.fn((s: any) => s?.kind ?? 'keyword'),
  HARD_SUPPRESSION_STRENGTH: 0.8,
}));

jest.mock('../location-service', () => ({
  getAll: jest.fn(async () => []),
  setWeight: jest.fn(async () => {}),
}));

jest.mock('../publication-preference-service', () => ({
  getPreferenceKind: jest.fn(async () => 'none'),
  setPreferenceKind: jest.fn(async () => {}),
}));

jest.mock('../persona-change-log-service', () => ({
  append: jest.fn(async () => ({ id: 'cl-1' })),
}));

jest.mock('../mutation-rails-service', () => ({
  nudgeTopic: jest.fn(async () => ({ applied: true, after: 0.5 })),
  setTopicWeightAbsolute: jest.fn(async () => ({ applied: true, before: 0, after: 0.5 })),
  setTopicHighPriority: jest.fn(async () => {}),
  nudgeFactWeight: jest.fn(async () => {}),
}));

jest.mock('@/lib/services/suppression-sweep', () => ({
  purgeHardFilteredSuggestions: jest.fn(async () => ({
    excludedIds: [],
    valueById: new Map(),
    evictedFromFeed: 0,
  })),
  unexcludeRetiredHardFilters: jest.fn(async () => ({ resetIds: [], stillExcluded: 0 })),
}));

const mockSetFeedNeedsRefresh = jest.fn();
jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: { getState: () => ({ setFeedNeedsRefresh: mockSetFeedNeedsRefresh }) },
}));

import { applyPersonaAction } from '../persona-action-executor';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import * as suppressionService from '../suppression-service';
import * as pubPrefService from '../publication-preference-service';
import * as changeLogService from '../persona-change-log-service';
import * as sweep from '@/lib/services/suppression-sweep';

const append = changeLogService.append as jest.Mock;
const addSuppression = suppressionService.addSuppression as jest.Mock;
const getAllSuppressions = suppressionService.getAll as jest.Mock;
const retireSuppression = suppressionService.retireSuppression as jest.Mock;
const purge = sweep.purgeHardFilteredSuggestions as jest.Mock;
const unexclude = sweep.unexcludeRetiredHardFilters as jest.Mock;

/** A stored suppression row, shaped as the model reads. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'sup-1',
  pattern: 'celebrity gossip',
  strength: 0.9,
  kind: null,
  value: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  (pubPrefService.getPreferenceKind as jest.Mock).mockResolvedValue('none');
  getAllSuppressions.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// add_suppression — structured kind/value + the row-source fix
// ---------------------------------------------------------------------------

describe('add_suppression: structured kinds', () => {
  it('passes a valid kind + value through to the service and logs them', async () => {
    const res = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'Sports',
        suppressionKind: 'category',
        suppressionValue: 'sports',
      },
      'feedback',
    );

    expect(addSuppression).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'category', value: 'sports' }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: ACTION_NAMES.ADD_SUPPRESSION,
        action: { targetId: 'sup-1', kind: 'category', value: 'sports' },
      }),
    );
    expect(res.applied).toBe(true);
  });

  it.each(['publication', 'entity', 'place', 'event_type', 'topic', 'keyword'])(
    'accepts the v46 kind %s',
    async (kind) => {
      await applyPersonaAction(
        {
          action_type: ACTION_NAMES.ADD_SUPPRESSION,
          suppressionPattern: 'x',
          suppressionKind: kind,
          suppressionValue: 'v',
        },
        'feedback',
      );
      expect(addSuppression).toHaveBeenCalledWith(expect.objectContaining({ kind }));
    },
  );

  it('degrades an unrecognised kind to undefined (⇒ NULL ⇒ keyword)', async () => {
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'x',
        suppressionKind: 'sentiment', // not in SUPPRESSION_KINDS
        suppressionValue: 'negative',
      },
      'feedback',
    );
    const arg = addSuppression.mock.calls[0][0];
    expect(arg.kind).toBeUndefined();
    // The value is still carried; it is inert without a structured kind.
    expect(arg.value).toBe('negative');
  });

  it.each(['category', 'entity', 'publication', 'place', 'event_type', 'topic'])(
    'degrades a VALUELESS structured kind %s to keyword (it could never match)',
    async (kind) => {
      // The matcher treats an absent value on a structured kind as "matches
      // nothing", so persisting one would be a filter that looks active and
      // silently does nothing.
      await applyPersonaAction(
        {
          action_type: ACTION_NAMES.ADD_SUPPRESSION,
          suppressionPattern: 'Sports',
          suppressionKind: kind,
          suppressionValue: '   ', // whitespace-only counts as absent
        },
        'feedback',
      );
      expect(addSuppression.mock.calls[0][0].kind).toBeUndefined();
    },
  );

  it('keeps an explicit keyword kind even with no value (keywords carry it)', async () => {
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'gossip',
        suppressionKind: 'keyword',
        suppressionKeywords: ['gossip'],
      },
      'feedback',
    );
    expect(addSuppression.mock.calls[0][0].kind).toBe('keyword');
  });

  it('leaves kind/value undefined when the action omits them', async () => {
    await applyPersonaAction(
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'gossip' },
      'feedback',
    );
    const arg = addSuppression.mock.calls[0][0];
    expect(arg.kind).toBeUndefined();
    expect(arg.value).toBeUndefined();
  });
});

describe('add_suppression: row source', () => {
  it("stores source 'user' for a user-created filter (was hardcoded 'feedback')", async () => {
    await applyPersonaAction(
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'gossip' },
      'user',
    );
    expect(addSuppression).toHaveBeenCalledWith(expect.objectContaining({ source: 'user' }));
  });

  it.each(['feedback', 'chat', 'digest', 'nudge'] as const)(
    "maps change-log source %s to row source 'feedback'",
    async (source) => {
      await applyPersonaAction(
        { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'gossip' },
        source,
      );
      expect(addSuppression).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'feedback' }),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// D12 — which action/condition runs which sweep
// ---------------------------------------------------------------------------

describe('D12: hard filters are retroactive', () => {
  it('a HARD add (strength ≥ 0.8) purges the already-stored feed', async () => {
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'gossip',
        suppressionStrength: 0.9,
      },
      'user',
    );
    expect(purge).toHaveBeenCalledTimes(1);
    expect(unexclude).not.toHaveBeenCalled();
  });

  it('a suppression exactly AT the hard threshold purges', async () => {
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'gossip',
        suppressionStrength: 0.8,
      },
      'user',
    );
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('a SOFT add runs NEITHER sweep', async () => {
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'gossip',
        suppressionStrength: 0.5,
      },
      'user',
    );
    expect(purge).not.toHaveBeenCalled();
    expect(unexclude).not.toHaveBeenCalled();
  });

  it('the default strength is soft, so a bare add runs neither sweep', async () => {
    await applyPersonaAction(
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'gossip' },
      'user',
    );
    expect(purge).not.toHaveBeenCalled();
    expect(unexclude).not.toHaveBeenCalled();
  });

  it('muting a publication purges; a non-mute pref change runs neither', async () => {
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
        publicationId: 'The Times',
        publicationPref: 'mute',
      },
      'user',
    );
    expect(purge).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    (pubPrefService.getPreferenceKind as jest.Mock).mockResolvedValue('none');
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
        publicationId: 'The Times',
        publicationPref: 'deprioritize',
      },
      'user',
    );
    expect(purge).not.toHaveBeenCalled();
    expect(unexclude).not.toHaveBeenCalled();
  });

  it('UN-muting a publication releases the rows the mute had excluded', async () => {
    (pubPrefService.getPreferenceKind as jest.Mock).mockResolvedValue('mute');
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
        publicationId: 'The Times',
        publicationPref: 'boost',
      },
      'user',
    );
    expect(unexclude).toHaveBeenCalledTimes(1);
    expect(purge).not.toHaveBeenCalled();
  });

  it('a sweep failure does NOT fail the action (already committed + audited)', async () => {
    purge.mockRejectedValueOnce(new Error('scoring context unavailable'));
    const res = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'gossip',
        suppressionStrength: 0.9,
      },
      'user',
    );
    expect(res).toMatchObject({ applied: true, changeLogId: 'cl-1' });
  });
});

// ---------------------------------------------------------------------------
// retire_suppression
// ---------------------------------------------------------------------------

describe('retire_suppression', () => {
  it('loads the row first so the audit entry names the pattern, then retires', async () => {
    getAllSuppressions.mockResolvedValue([row({ kind: 'publication', strength: 0.5 })]);
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_SUPPRESSION, suppressionId: 'sup-1' },
      'user',
    );

    expect(retireSuppression).toHaveBeenCalledWith('sup-1');
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: ACTION_NAMES.RETIRE_SUPPRESSION,
        action: { targetId: 'sup-1', pattern: 'celebrity gossip', kind: 'publication' },
      }),
    );
    expect(res).toMatchObject({
      applied: true,
      changeLogId: 'cl-1',
      summary: 'Removed filter: celebrity gossip',
    });
  });

  it('logs kind "keyword" for a pre-v46 row with a NULL kind', async () => {
    getAllSuppressions.mockResolvedValue([row({ kind: null, strength: 0.5 })]);
    await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_SUPPRESSION, suppressionId: 'sup-1' },
      'user',
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.objectContaining({ kind: 'keyword' }) }),
    );
  });

  it('retiring a HARD filter releases the rows it had excluded', async () => {
    getAllSuppressions.mockResolvedValue([row({ strength: 0.9 })]);
    await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_SUPPRESSION, suppressionId: 'sup-1' },
      'user',
    );
    expect(unexclude).toHaveBeenCalledTimes(1);
    expect(purge).not.toHaveBeenCalled();
  });

  it('retiring a SOFT filter runs no sweep (it never excluded anything)', async () => {
    getAllSuppressions.mockResolvedValue([row({ strength: 0.4 })]);
    await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_SUPPRESSION, suppressionId: 'sup-1' },
      'user',
    );
    expect(unexclude).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
  });

  it('skips (no write) when suppressionId is missing', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_SUPPRESSION },
      'user',
    );
    expect(res.applied).toBe(false);
    expect(retireSuppression).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('reports not-applied when the suppression no longer exists', async () => {
    getAllSuppressions.mockResolvedValue([row({ id: 'other' })]);
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_SUPPRESSION, suppressionId: 'sup-1' },
      'user',
    );
    expect(res).toEqual({ applied: false, summary: 'suppression not found' });
    expect(retireSuppression).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D18 — persona change ⇒ feed marked dirty (with the purge exception)
// ---------------------------------------------------------------------------

describe('D18: feed dirty marking at the seam', () => {
  it('marks the feed dirty for a soft suppression (needs a rescore)', async () => {
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'gossip',
        suppressionStrength: 0.5,
      },
      'feedback',
    );
    expect(mockSetFeedNeedsRefresh).toHaveBeenCalledWith(true);
  });

  it('marks the feed dirty for a chat/feedback topic mutation (the pre-P3 gap)', async () => {
    await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_TOPIC, topicId: 't1' },
      'chat',
    );
    expect(mockSetFeedNeedsRefresh).toHaveBeenCalledWith(true);
  });

  it('does NOT dirty after a purge — that already refreshed the UI immediately', async () => {
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'gossip',
        suppressionStrength: 0.9,
      },
      'user',
    );
    expect(purge).toHaveBeenCalled();
    expect(mockSetFeedNeedsRefresh).not.toHaveBeenCalled();
  });

  it('DOES dirty after an un-exclude — released rows come back unscored', async () => {
    getAllSuppressions.mockResolvedValue([row({ strength: 0.9 })]);
    await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_SUPPRESSION, suppressionId: 'sup-1' },
      'user',
    );
    expect(unexclude).toHaveBeenCalled();
    expect(mockSetFeedNeedsRefresh).toHaveBeenCalledWith(true);
  });

  it('dirties when a purge FAILED — the feed was never reconciled', async () => {
    purge.mockRejectedValueOnce(new Error('boom'));
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'gossip',
        suppressionStrength: 0.9,
      },
      'user',
    );
    expect(mockSetFeedNeedsRefresh).toHaveBeenCalledWith(true);
  });

  it('does NOT dirty for a nudge suggestion or an unsupported action', async () => {
    await applyPersonaAction(
      { action_type: ACTION_NAMES.NUDGE_BROWSE_RELATED, topicText: 'space' },
      'feedback',
    );
    await applyPersonaAction({ action_type: ACTION_NAMES.MERGE_FACTS }, 'feedback');
    expect(mockSetFeedNeedsRefresh).not.toHaveBeenCalled();
  });

  it('does NOT dirty for a skipped action', async () => {
    await applyPersonaAction({ action_type: ACTION_NAMES.RETIRE_TOPIC }, 'feedback');
    expect(mockSetFeedNeedsRefresh).not.toHaveBeenCalled();
  });

  it('never leaks the internal `purged` flag into the public result', async () => {
    const res = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'gossip',
        suppressionStrength: 0.9,
      },
      'user',
    );
    expect(Object.keys(res).sort()).toEqual(['applied', 'changeLogId', 'summary']);
  });
});
