// publication-preference-service and suppression-service: the row semantics the persona mutations rest
// on (kind <-> weight mapping, name and scope matching, expiry), on the real in-memory DB.
import {
  PUBLICATION_PREF_WEIGHT,
  getActive,
  getActiveNamedPublications,
  getActiveScopes,
  getAll,
  getPreferenceKind,
  getScopePreferenceKind,
  observeActive,
  retirePreference,
  setPreferenceKind,
  setScopePreferenceKind,
  upsertPreference,
  upsertScopePreference,
  weightToPrefKind,
} from '@/lib/database/services/publication-preference-service';
import {
  HARD_SUPPRESSION_STRENGTH,
  SUPPRESSION_DEFAULT_TTL_MS,
  addSuppression,
  getActive as activeSuppressions,
  getAll as allSuppressions,
  kindOf,
  observeActive as observeActiveSuppressions,
  reactivateSuppression,
  retireSuppression,
} from '@/lib/database/services/suppression-service';
import { DAY, MIN, NOON, freezeClock, quietLogger, resetPersonaMemory, settleWrites } from './support';
import { firstValueFrom } from 'rxjs';

let logs: ReturnType<typeof quietLogger>;
beforeEach(() => {
  logs = quietLogger();
  resetPersonaMemory();
});
afterEach(async () => {
  await settleWrites();
  logs.restore();
});

describe('weightToPrefKind / PUBLICATION_PREF_WEIGHT', () => {
  it.each([
    [-1, 'mute'], [-0.9, 'mute'], [-0.89, 'deprioritize'], [-0.5, 'deprioritize'], [-0.01, 'deprioritize'],
    [0, null], [0.01, 'boost'], [1, 'boost'],
  ] as const)('weight %s reads as %s', (weight, kind) => {
    expect(weightToPrefKind(weight)).toBe(kind);
  });

  it('every kind writes a weight that reads back as itself', () => {
    for (const [kind, weight] of Object.entries(PUBLICATION_PREF_WEIGHT)) expect(weightToPrefKind(weight)).toBe(kind);
  });
});

describe('named publication preferences', () => {
  it('upsert dedupes on the normalized name, trims on create, clamps to [-1, 1] and re-activates a retired row', async () => {
    const first = await upsertPreference({ publicationName: '  The   Times ', weight: 7 });
    expect(first.publicationName).toBe('The   Times'); // @text trims the ends only
    expect(first.weight).toBe(1);
    await retirePreference(first.id);

    const again = await upsertPreference({ publicationName: 'the times', weight: -7, sourceCountryCode: 'GB' });

    expect(again.id).toBe(first.id);
    expect(await getAll()).toHaveLength(1);
    expect(again).toMatchObject({ weight: -1, status: 'active', sourceCountryCode: 'GB' });
  });

  it('getPreferenceKind only sees ACTIVE NAMED rows', async () => {
    await upsertScopePreference({ scopeKind: 'country', scopeValue: 'IND', label: 'India', weight: 0.5 });
    const retired = await upsertPreference({ publicationName: 'Gone', weight: 0.5 });
    await retirePreference(retired.id);

    expect(await getPreferenceKind('India')).toBe('none');
    expect(await getPreferenceKind('Gone')).toBe('none');
  });

  it("'none' retires the active row (history kept); a concrete kind upserts its canonical weight and provenance", async () => {
    await setPreferenceKind('The Times', 'boost', 'migration');
    expect((await getAll())[0]).toMatchObject({ weight: 0.5, provenance: 'migration', status: 'active' });

    await setPreferenceKind('the times', 'none');

    expect((await getAll())[0].status).toBe('retired');
    expect(await getActive()).toEqual([]);
    await setPreferenceKind('The Times', 'none'); // nothing active: a no-op
    expect(await getAll()).toHaveLength(1);
  });

  it('observeActive emits the active rows', async () => {
    await setPreferenceKind('The Times', 'boost');
    const retired = await upsertPreference({ publicationName: 'Gone', weight: 0.5 });
    await retirePreference(retired.id);

    expect((await firstValueFrom(observeActive())).map((p) => p.publicationName)).toEqual(['The Times']);
  });
});

describe('source scope preferences', () => {
  it('matches on kind plus the normalized value (case and padding insensitive) and stores the upper-cased token', async () => {
    const row = await upsertScopePreference({ scopeKind: 'country', scopeValue: ' ind ', label: ' India ', weight: 9 });

    expect(row).toMatchObject({ scopeValue: 'IND', publicationName: 'India', weight: 1, sourceCountryCode: null });
    expect(await getScopePreferenceKind({ scopeKind: 'country', scopeValue: 'Ind' })).toBe('boost');
    const again = await upsertScopePreference({ scopeKind: 'country', scopeValue: 'IND', label: 'Republic of India', weight: -0.5 });
    expect(again.id).toBe(row.id);
    expect(await getAll()).toHaveLength(1);
  });

  it('a blank scope value matches nothing, and retiring it is a no-op', async () => {
    await upsertScopePreference({ scopeKind: 'country', scopeValue: 'IND', label: 'India', weight: 0.5 });

    expect(await getScopePreferenceKind({ scopeKind: 'country', scopeValue: '  ' })).toBe('none');
    await setScopePreferenceKind({ scopeKind: 'country', scopeValue: '  ' }, 'none', 'x');
    expect((await getAll())[0].status).toBe('active');
  });

  it("'none' retires the active scope row, keeping its label for the audit trail", async () => {
    await setScopePreferenceKind({ scopeKind: 'country', scopeValue: 'IND' }, 'deprioritize', 'India', 'user');

    await setScopePreferenceKind({ scopeKind: 'country', scopeValue: 'IND' }, 'none', 'ignored');

    expect((await getAll())[0]).toMatchObject({ status: 'retired', publicationName: 'India', provenance: 'user' });
  });

  it('active scopes and active named publications never leak into each other', async () => {
    await setPreferenceKind('The Times', 'boost');
    await setScopePreferenceKind({ scopeKind: 'country', scopeValue: 'IND' }, 'boost', 'India');
    const retired = await upsertPreference({ publicationName: 'Gone', weight: 0.5 });
    await retirePreference(retired.id);

    expect((await getActiveScopes()).map((p) => p.scopeValue)).toEqual(['IND']);
    expect((await getActiveNamedPublications()).map((p) => p.publicationName)).toEqual(['The Times']);
    expect(await getActive()).toHaveLength(2);
  });
});

describe('suppressions', () => {
  it('addSuppression trims the pattern, clamps strength to [0, 1] and stores NULL kind/value when omitted', async () => {
    const hi = await addSuppression({ pattern: '  gossip ', strength: 4, source: 'user' });
    const lo = await addSuppression({ pattern: 'x', strength: -4, source: 'user', kind: 'topic', value: 'v' });

    expect(hi).toMatchObject({ pattern: 'gossip', strength: 1, kind: null, value: null, status: 'active', keywords: [] });
    expect(lo).toMatchObject({ strength: 0, kind: 'topic', value: 'v' });
    expect(kindOf(hi)).toBe('keyword');
    expect(kindOf(lo)).toBe('topic');
  });

  it(`expiry: soft defaults to now + ${SUPPRESSION_DEFAULT_TTL_MS / DAY} days, hard to none, and an explicit value wins`, async () => {
    freezeClock(NOON);

    const soft = await addSuppression({ pattern: 'a', strength: HARD_SUPPRESSION_STRENGTH - 0.01, source: 'user' });
    const hard = await addSuppression({ pattern: 'b', strength: HARD_SUPPRESSION_STRENGTH, source: 'user' });
    const explicit = await addSuppression({ pattern: 'c', strength: 0.5, source: 'user', expiresAt: NOON + MIN });
    const never = await addSuppression({ pattern: 'd', strength: 0.5, source: 'user', expiresAt: null });

    expect(soft.expiresAt).toBe(NOON + 30 * DAY);
    expect(hard.expiresAt).toBeNull();
    expect(explicit.expiresAt).toBe(NOON + MIN);
    expect(never.expiresAt).toBeNull();
  });

  it('getActive drops retired and expired rows, with the expiry instant itself already expired', async () => {
    freezeClock(NOON);
    await addSuppression({ pattern: 'short', strength: 0.5, source: 'user', expiresAt: NOON + MIN });
    const retired = await addSuppression({ pattern: 'retired', strength: 1, source: 'user' });
    await addSuppression({ pattern: 'forever', strength: 1, source: 'user' });
    await retireSuppression(retired.id);

    expect((await activeSuppressions()).map((s) => s.pattern).sort()).toEqual(['forever', 'short']);
    jest.setSystemTime(NOON + MIN - 1);
    expect((await activeSuppressions()).map((s) => s.pattern).sort()).toEqual(['forever', 'short']);
    jest.setSystemTime(NOON + MIN);
    expect((await activeSuppressions()).map((s) => s.pattern)).toEqual(['forever']);
    expect((await activeSuppressions(NOON)).map((s) => s.pattern).sort()).toEqual(['forever', 'short']);
  });

  it('getAll lists every row newest first; observeActive emits only active rows; reactivate flips status back', async () => {
    freezeClock(NOON);
    const older = await addSuppression({ pattern: 'older', strength: 1, source: 'user' });
    jest.setSystemTime(NOON + MIN);
    await addSuppression({ pattern: 'newer', strength: 1, source: 'user' });
    await retireSuppression(older.id);

    expect((await allSuppressions()).map((s) => s.pattern)).toEqual(['newer', 'older']);
    expect((await firstValueFrom(observeActiveSuppressions())).map((s) => s.pattern)).toEqual(['newer']);
    await reactivateSuppression(older.id);
    expect((await allSuppressions()).every((s) => s.status === 'active')).toBe(true);
  });
});
