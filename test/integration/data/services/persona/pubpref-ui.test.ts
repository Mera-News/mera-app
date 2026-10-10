// publication-pref-ui-actions: the ONE writer behind every More/Fewer control, on the real DB.
// A publication has SEVERAL names: a `publisher` target writes one row per name, reads its level
// across all of them (fewer wins, a mute reads as fewer) and is undone by revertSourcePrefChange,
// never by one revertChange. Replaces the mocked publication-pref-ui-actions suite.
import database from '@/lib/database';
import { batchMarkExcluded } from '@/lib/database/services/article-suggestion-scoring-writes';
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import { revertChange } from '@/lib/database/services/persona-change-log-service';
import {
  getPublisherPrefLevel,
  revertSourcePrefChange,
  setSourcePrefFromUi,
  type SetSourcePrefResult,
} from '@/lib/database/services/publication-pref-ui-actions';
import { getPreferenceKind, getScopePreferenceKind, setPreferenceKind, upsertScopePreference } from '@/lib/database/services/publication-preference-service';
import { useForYouStore } from '@/lib/stores/for-you-store';
import {
  logRow,
  logRows,
  logsOf,
  quietLogger,
  resetPersonaMemory,
  restoreFaults,
  rowsOf,
  seedArticles,
  settleWrites,
  statuses,
} from './support';

let logs: ReturnType<typeof quietLogger>;
beforeEach(() => {
  logs = quietLogger();
  resetPersonaMemory();
});
afterEach(async () => {
  restoreFaults();
  await settleWrites();
  logs.restore();
});

const last = <T>(xs: T[]): T => xs[xs.length - 1];
const NAMES = ['Times of India', 'TOI Business', 'times of india ', 'Times Now'];
const pub = (publicationName: string) => ({ kind: 'publication', publicationName }) as const;
const publisher = (names: readonly string[]) => ({ kind: 'publisher', names }) as const;
const india = { kind: 'country', countryAlpha2: 'IN', label: 'India' } as const;

const weightOf = async (name: string) => {
  const rows = await rowsOf('publication_preferences');
  return rows.find((p) => p.scopeKind == null && p.publicationName.toLowerCase().trim() === name.toLowerCase().trim());
};
const kinds = async (names: string[]) => Object.fromEntries(await Promise.all(names.map(async (n) => [n, await getPreferenceKind(n)])));

// ---------------------------------------------------------------------------
// Single named publication
// ---------------------------------------------------------------------------

describe('publication target: more / fewer', () => {
  it.each(['none', 'boost', 'deprioritize'] as const)('prioritised from %s writes a boost through the executor, as a user action', async (before) => {
    if (before !== 'none') await setPreferenceKind('The Times', before, 'user');

    const result = await setSourcePrefFromUi(pub('The Times'), 'prioritised');

    expect(result.applied).toBe(true);
    expect(await getPreferenceKind('The Times')).toBe('boost');
    expect(await logsOf('set_publication_pref')).toHaveLength(1); // the executor owns the one row
    const row = last(await logsOf('set_publication_pref'));
    expect(result.changeLogId).toBe(row.id);
    expect(row).toMatchObject({ source: 'user', action: { targetId: 'The Times', before, after: 'boost' } });
    expect((await weightOf('The Times')).provenance).toBe('user');
  });

  it.each(['none', 'boost', 'deprioritize'] as const)('deprioritised from %s writes a deprioritize', async (before) => {
    if (before !== 'none') await setPreferenceKind('The Times', before, 'user');

    const result = await setSourcePrefFromUi(pub('The Times'), 'deprioritised');

    expect(result.applied).toBe(true);
    expect(await getPreferenceKind('The Times')).toBe('deprioritize');
    expect(await logsOf('set_publication_pref')).toHaveLength(1);
    expect(last(await logsOf('set_publication_pref')).action).toEqual({ targetId: 'The Times', before, after: 'deprioritize' });
  });

  it('surfaces applied:false, with nothing written, when the executor refuses the write', async () => {
    const result = await setSourcePrefFromUi(pub(''), 'prioritised');

    expect(result).toEqual({ applied: false, changeLogId: undefined });
    expect(await logRows()).toEqual([]);
    expect(await rowsOf('publication_preferences')).toEqual([]);
  });

  it('setting an unmuted level over a MUTE releases the publication', async () => {
    await seedArticles([{ id: 'a', title: 'Budget day', publication: 'The Times' }]);
    await applyPersonaAction({ action_type: 'set_publication_pref', publicationId: 'The Times', publicationPref: 'mute' }, 'user');
    expect((await statuses()).a).toBe('excluded');

    await setSourcePrefFromUi(pub('The Times'), 'deprioritised');

    expect((await statuses()).a).toBe('unscored');
  });
});

describe('publication target: clear', () => {
  it.each(['none', 'boost', 'deprioritize'] as const)('clearing from %s retires the row and hand-appends the log row', async (before) => {
    if (before !== 'none') await setPreferenceKind('The Times', before, 'user');

    const result = await setSourcePrefFromUi(pub('The Times'), 'none');

    expect(await getPreferenceKind('The Times')).toBe('none');
    const [row] = await logsOf('set_publication_pref');
    expect(result).toEqual({ applied: true, changeLogId: row.id });
    expect(row).toMatchObject({
      source: 'user',
      action: { targetId: 'The Times', before, after: 'none' },
      summary: 'Cleared publication preference: The Times',
    });
    if (before !== 'none') expect(await weightOf('The Times')).toMatchObject({ status: 'retired' });
  });

  it('clearing a MUTE gives the publication a second chance (un-exclude sweep)', async () => {
    await seedArticles([
      { id: 'a', title: 'Budget day', publication: 'The Times' },
      { id: 'b', title: 'Budget day', publication: 'The Sun' },
    ]);
    await applyPersonaAction({ action_type: 'set_publication_pref', publicationId: 'The Times', publicationPref: 'mute' }, 'user');
    expect(await statuses()).toEqual({ a: 'excluded', b: 'unscored' });

    await setSourcePrefFromUi(pub('The Times'), 'none');

    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
  });

  it('clearing a boost sweeps nothing: a stale excluded row is left alone and the store is not refreshed', async () => {
    await seedArticles([{ id: 'a', title: 'x', publication: 'The Sun' }]);
    await batchMarkExcluded(['a']);
    await setPreferenceKind('The Times', 'boost', 'user');

    await setSourcePrefFromUi(pub('The Times'), 'none');

    expect((await statuses()).a).toBe('excluded');
    expect(useForYouStore.getState().suggestions).toEqual([]);
  });

  it('a clear is undone by its change-log id, restoring the prior kind', async () => {
    await setPreferenceKind('The Times', 'boost', 'user');
    const result = await setSourcePrefFromUi(pub('The Times'), 'none');

    await expect(revertChange(result.changeLogId!)).resolves.toBe(true);

    expect(await getPreferenceKind('The Times')).toBe('boost');
  });
});

// ---------------------------------------------------------------------------
// Country scope
// ---------------------------------------------------------------------------

describe('country scope target', () => {
  it('prioritised converts alpha-2 to alpha-3 and writes a boosted scope row labelled for the screen', async () => {
    const result = await setSourcePrefFromUi(india, 'prioritised');

    expect(result.applied).toBe(true);
    const [row] = await rowsOf('publication_preferences');
    expect(row).toMatchObject({ scopeKind: 'country', scopeValue: 'IND', publicationName: 'India', weight: 0.5, status: 'active', provenance: 'user' });
    expect((await logsOf('set_source_scope_pref'))[0]).toMatchObject({
      id: result.changeLogId,
      source: 'user',
      action: { targetId: 'country:IND', before: 'none', after: 'boost', label: 'India' },
    });
  });

  it('deprioritised accepts a lower-case alpha-2 and writes a deprioritize', async () => {
    await setSourcePrefFromUi({ kind: 'country', countryAlpha2: 'in', label: 'India' }, 'deprioritised');

    expect(await getScopePreferenceKind({ scopeKind: 'country', scopeValue: 'IND' })).toBe('deprioritize');
  });

  it('an unmappable alpha-2 fails closed for a set and for a clear: applied:false, nothing written', async () => {
    const bad = { kind: 'country', countryAlpha2: 'ZZ', label: 'Nowhere' } as const;

    expect(await setSourcePrefFromUi(bad, 'prioritised')).toEqual({ applied: false });
    expect(await setSourcePrefFromUi(bad, 'none')).toEqual({ applied: false });
    expect(await logRows()).toEqual([]);
    expect(await rowsOf('publication_preferences')).toEqual([]);
  });

  it('clear retires the scope row, appends a composite-target row, returns no change-log id and sweeps nothing', async () => {
    await upsertScopePreference({ scopeKind: 'country', scopeValue: 'IND', label: 'India', weight: 0.5, provenance: 'user' });
    await seedArticles([{ id: 'a', title: 'x', publication: 'India' }]);

    const result = await setSourcePrefFromUi(india, 'none');

    expect(result).toEqual({ applied: true });
    expect((await rowsOf('publication_preferences'))[0].status).toBe('retired');
    expect((await logsOf('set_source_scope_pref'))[0]).toMatchObject({
      source: 'user',
      action: { targetId: 'country:IND', before: 'boost', after: 'none' },
      summary: 'Cleared source-scope preference: India',
    });
    expect(await statuses()).toEqual({ a: 'unscored' });
    expect(useForYouStore.getState().suggestions).toEqual([]);
  });

  it('a scope row never reads as a publication with the same name', async () => {
    await setSourcePrefFromUi(india, 'prioritised');

    expect(await getPreferenceKind('India')).toBe('none');
    expect(await getPublisherPrefLevel(['India'])).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Publisher: one publication, several names
// ---------------------------------------------------------------------------

describe('publisher target: a write reaches every name', () => {
  it('prioritised writes one boost row per DISTINCT normalized name, in order, and returns every log id', async () => {
    const result = await setSourcePrefFromUi(publisher(NAMES), 'prioritised');

    expect(await kinds(['Times of India', 'TOI Business', 'Times Now'])).toEqual({
      'Times of India': 'boost',
      'TOI Business': 'boost',
      'Times Now': 'boost',
    });
    expect(await rowsOf('publication_preferences')).toHaveLength(3);
    const written = await logsOf('set_publication_pref');
    expect(written.map((r) => r.action.targetId)).toEqual(['Times of India', 'TOI Business', 'Times Now']);
    expect(result).toEqual({ applied: true, changeLogId: written[0].id, changeLogIds: written.map((r) => r.id) });
  });

  it('skips a name already at the requested level, so an undo reverts only what changed', async () => {
    await setPreferenceKind('TOI Business', 'deprioritize', 'user');

    const result = await setSourcePrefFromUi(publisher(['Times of India', 'TOI Business']), 'deprioritised');

    const written = await logsOf('set_publication_pref');
    expect(written.map((r) => r.action.targetId)).toEqual(['Times of India']);
    expect(result.changeLogIds).toEqual([written[0].id]);
    expect(await kinds(['Times of India', 'TOI Business'])).toEqual({ 'Times of India': 'deprioritize', 'TOI Business': 'deprioritize' });
  });

  it('pressing the level already shown logs nothing and still succeeds', async () => {
    await setSourcePrefFromUi(publisher(NAMES), 'prioritised');
    const before = (await logRows()).length;

    const result = await setSourcePrefFromUi(publisher(NAMES), 'prioritised');

    expect(result).toEqual({ applied: true, changeLogId: undefined, changeLogIds: [] });
    expect((await logRows()).length).toBe(before);
  });

  it('never softens a mute when asked for fewer', async () => {
    await setPreferenceKind('Times of India', 'mute', 'user');

    const result = await setSourcePrefFromUi(publisher(['Times of India']), 'deprioritised');

    expect(result).toEqual({ applied: true, changeLogId: undefined, changeLogIds: [] });
    expect(await getPreferenceKind('Times of India')).toBe('mute');
    expect(await logRows()).toEqual([]);
  });

  it('asking for more over a mute DOES write the boost, and releases the muted rows', async () => {
    await seedArticles([{ id: 'a', title: 'x', publication: 'Times of India' }]);
    await applyPersonaAction({ action_type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' }, 'user');
    expect((await statuses()).a).toBe('excluded');

    await setSourcePrefFromUi(publisher(['Times of India']), 'prioritised');

    expect(await getPreferenceKind('Times of India')).toBe('boost');
    expect((await statuses()).a).toBe('unscored');
  });

  it('clear retires EVERY name with an active row (a mute included), and only those', async () => {
    await setPreferenceKind('Times of India', 'boost', 'user');
    await setPreferenceKind('TOI Business', 'mute', 'user');

    const result = await setSourcePrefFromUi(publisher(NAMES), 'none');

    expect(await kinds(['Times of India', 'TOI Business', 'Times Now'])).toEqual({ 'Times of India': 'none', 'TOI Business': 'none', 'Times Now': 'none' });
    const written = await logsOf('set_publication_pref');
    expect(written.map((r) => [r.action.targetId, r.action.before])).toEqual([['Times of India', 'boost'], ['TOI Business', 'mute']]);
    expect(result).toEqual({ applied: true, changeLogId: written[0].id, changeLogIds: written.map((r) => r.id) });
  });

  it('clear runs the sweep policy per name: only the muted name gets its rows released', async () => {
    await seedArticles([
      { id: 'a', title: 'x', publication: 'TOI Business' },
      { id: 'b', title: 'x', publication: 'Times Now' },
    ]);
    await applyPersonaAction({ action_type: 'set_publication_pref', publicationId: 'TOI Business', publicationPref: 'mute' }, 'user');
    await setPreferenceKind('Times of India', 'boost', 'user');
    expect((await statuses()).a).toBe('excluded');

    await setSourcePrefFromUi(publisher(NAMES), 'none');

    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
  });

  it('stops at a refused write and still returns what it wrote, for undo', async () => {
    const col = database.get('publication_preferences') as any;
    const real = col.create.bind(col);
    let calls = 0;
    const spy = jest.spyOn(col, 'create').mockImplementation(((...args: unknown[]) =>
      ++calls === 2 ? Promise.reject(new Error('disk full')) : real(...args)) as never);

    let result: SetSourcePrefResult;
    try {
      result = await setSourcePrefFromUi(publisher(['A', 'B', 'C']), 'prioritised');
    } finally {
      spy.mockRestore();
    }

    const written = await logsOf('set_publication_pref');
    expect(written.map((r) => r.action.targetId)).toEqual(['A']);
    expect(result).toEqual({ applied: false, changeLogId: written[0].id, changeLogIds: [written[0].id] });
    expect(calls).toBe(2); // C was never attempted
    expect(logs.captureException).toHaveBeenCalledTimes(1);
    expect(await revertSourcePrefChange(result)).toBe(true);
    expect(await getPreferenceKind('A')).toBe('none');
  });

  it('an empty name set writes nothing and reports applied:false', async () => {
    const result = await setSourcePrefFromUi(publisher(['  ', '']), 'prioritised');

    expect(result).toEqual({ applied: false });
    expect(await logRows()).toEqual([]);
    expect(await rowsOf('publication_preferences')).toEqual([]);
  });
});

describe('[dead-candidate] getPublisherPrefLevel', () => {
  it('reads across every name, fewer winning over more, matching on normalized names', async () => {
    await setPreferenceKind('Times of India', 'boost', 'user');
    await setPreferenceKind('TOI Business', 'deprioritize', 'user');

    await expect(getPublisherPrefLevel(['Times of India', 'TOI Business'])).resolves.toBe('deprioritised');
    await expect(getPublisherPrefLevel(['  TIMES   of india'])).resolves.toBe('prioritised');
    await expect(getPublisherPrefLevel(['Times Now'])).resolves.toBe('none');
    await expect(getPublisherPrefLevel([])).resolves.toBe('none');
  });

  it('a mute reads as fewer, and a cleared (retired) name reads as none', async () => {
    await setPreferenceKind('Times of India', 'boost', 'user');
    await setPreferenceKind('TOI Business', 'mute', 'user');
    await expect(getPublisherPrefLevel(['Times of India', 'TOI Business'])).resolves.toBe('deprioritised');

    await setSourcePrefFromUi(publisher(['Times of India', 'TOI Business']), 'none');

    await expect(getPublisherPrefLevel(['Times of India', 'TOI Business'])).resolves.toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

describe('revertSourcePrefChange', () => {
  it('undoes a multi-row write exactly: new rows retired, a changed name back to its prior kind, untouched names untouched', async () => {
    await setPreferenceKind('TOI Business', 'deprioritize', 'user');
    await setPreferenceKind('Times Now', 'boost', 'user');
    const result = await setSourcePrefFromUi(publisher(['Times of India', 'TOI Business', 'Times Now']), 'prioritised');
    expect(result.changeLogIds).toHaveLength(2); // Times Now was already at the level
    const rowsAfterWrite = (await logRows()).length;

    await expect(revertSourcePrefChange(result)).resolves.toBe(true);

    expect(await kinds(['Times of India', 'TOI Business', 'Times Now'])).toEqual({
      'Times of India': 'none',
      'TOI Business': 'deprioritize',
      'Times Now': 'boost',
    });
    for (const id of result.changeLogIds!) expect((await logRow(id)).reverted).toBe(true);
    expect(await logsOf('revert_change')).toHaveLength(2);
    expect((await logRows()).length).toBe(rowsAfterWrite + 2);
  });

  it('is compare-and-set per row: a name changed since is left alone while the others revert', async () => {
    const result = await setSourcePrefFromUi(publisher(['Times of India', 'TOI Business']), 'deprioritised');
    await applyPersonaAction({ action_type: 'set_publication_pref', publicationId: 'TOI Business', publicationPref: 'boost' }, 'chat');

    await expect(revertSourcePrefChange(result)).resolves.toBe(true);

    expect(await kinds(['Times of India', 'TOI Business'])).toEqual({ 'Times of India': 'none', 'TOI Business': 'boost' });
    expect((await logRow(result.changeLogIds![1])).reverted).toBe(false);
  });

  it('returns false when every row has been superseded', async () => {
    const result = await setSourcePrefFromUi(publisher(['Times of India']), 'deprioritised');
    await applyPersonaAction({ action_type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'boost' }, 'chat');

    await expect(revertSourcePrefChange(result)).resolves.toBe(false);

    expect(await getPreferenceKind('Times of India')).toBe('boost');
  });

  it('undoing a clear of a mute re-purges what the mute blocked', async () => {
    await seedArticles([{ id: 'a', title: 'x', publication: 'Times of India' }]);
    await applyPersonaAction({ action_type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' }, 'user');
    const result = await setSourcePrefFromUi(publisher(['Times of India']), 'none');
    expect((await statuses()).a).toBe('unscored');

    await expect(revertSourcePrefChange(result)).resolves.toBe(true);

    expect(await getPreferenceKind('Times of India')).toBe('mute');
    expect((await statuses()).a).toBe('excluded');
  });

  it('falls back to the single changeLogId, and returns false with nothing to revert', async () => {
    const single: SetSourcePrefResult = await setSourcePrefFromUi(pub('The Times'), 'prioritised');
    expect(single.changeLogIds).toBeUndefined();

    await expect(revertSourcePrefChange({ applied: true, changeLogId: single.changeLogId })).resolves.toBe(true);
    expect(await getPreferenceKind('The Times')).toBe('none');

    await expect(revertSourcePrefChange({ applied: false })).resolves.toBe(false);
    await expect(revertSourcePrefChange({ applied: true, changeLogIds: [] })).resolves.toBe(false);
  });
});
