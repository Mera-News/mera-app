// updateClusterMemberships (D8/D13): the hourly membership refresh writes what the server
// answered onto rows already on the device. Update only: an id with no row is never inserted, an
// omitted id is "no info" and keeps its value, an empty list clears. The grouping case is the
// reason the refresh exists: copies hydrated before the clustering job ran carry their own
// singleton clusters, and only a later answer gives them the shared story.
import database from '@/lib/database';
import { loadSuggestions } from '@/lib/database/services/article-suggestion-reads';
import { updateClusterMemberships } from '@/lib/database/services/article-suggestion-persist';
import { buildStoryGroups, DISPLAY_GROUPING_OPTIONS, groupableOf } from '@/lib/algorithms/story-grouping';
import type { ArticleClusterMemberships } from '@/lib/generated/graphql-types';
import { article, freezeClock, idsInDb, row, seed, toComplete } from './support';

beforeEach(() => freezeClock());
afterEach(() => jest.restoreAllMocks());

const own = (id: string) => [{ __typename: 'ClusterMembership' as const, clusterId: `c-${id}`, confidence: 0.9, stableClusterId: null }];
const answer = (articleId: string, clusters: ArticleClusterMemberships['clusters']): ArticleClusterMemberships => ({
  __typename: 'ArticleClusterMemberships',
  articleId,
  clusters,
});
const bhopal = [{ __typename: 'ClusterMembership' as const, clusterId: 'c-bhopal', confidence: 0.82, stableClusterId: 's-bhopal' }];
const json = async (id: string) => JSON.parse((await row(id)).clusterMembershipsJson ?? 'null');

describe('updateClusterMemberships', () => {
  it('folds six copies of one story into one group once they share a stable cluster', async () => {
    // Six outlets, six headlines with no shared vocabulary: only the cluster can join them.
    const titles = [
      'Water supply cut across old city wards',
      'Municipal pipeline repair leaves residents dry',
      'Taps run empty in lake district neighbourhoods',
      'Civic body schedules tanker rounds',
      'Outage hits households near Upper Lake',
      'Corporation blames burst main for shortage',
    ];
    const ids = titles.map((_, i) => `b${i}`);
    await seed(ids.map((id, i) => article(id, { clusters: own(id), title_en: titles[i], title: titles[i] })));
    for (const id of ids) await toComplete(id, 0.85);
    const groups = async () =>
      buildStoryGroups((await loadSuggestions()).map(groupableOf), DISPLAY_GROUPING_OPTIONS).length;
    expect(await groups()).toBe(6);

    const changed = await updateClusterMemberships(ids.map((id) => answer(id, bhopal)));

    expect(changed).toBe(6);
    expect(await groups()).toBe(1);
    for (const id of ids) expect((await row(id)).stableClusterId).toBe('s-bhopal');
    expect(await row('b3')).toMatchObject({ status: 'complete', relevance: 0.85 });
  });

  it('keeps a stable cluster id the row already holds', async () => {
    await seed([article('held', { clusters: own('held') })]);
    await database.write(async () => {
      const r = await database.get<any>('article_suggestions').find('held');
      await r.update((x: any) => { x.stableClusterId = 's-meta'; });
    });

    await updateClusterMemberships([answer('held', bhopal)]);

    expect((await row('held')).stableClusterId).toBe('s-meta');
  });

  it('leaves an omitted id alone and clears an id answered with no clusters', async () => {
    await seed([article('kept', { clusters: own('kept') }), article('cleared', { clusters: own('cleared') })]);

    await updateClusterMemberships([answer('cleared', [])]);

    expect(await json('kept')).toEqual([{ clusterId: 'c-kept', confidence: 0.9 }]);
    expect(await json('cleared')).toEqual([]);
  });

  it('never inserts a row for an id the device does not hold', async () => {
    await seed([article('a1', { clusters: own('a1') })]);

    expect(await updateClusterMemberships([answer('stranger', bhopal)])).toBe(0);

    expect(await idsInDb()).toEqual(['a1']);
  });

  it('writes nothing when the answer matches what is stored, in any order', async () => {
    const two = [
      { __typename: 'ClusterMembership' as const, clusterId: 'c1', confidence: 0.9, stableClusterId: 's1' },
      { __typename: 'ClusterMembership' as const, clusterId: 'c2', confidence: 0.7, stableClusterId: null },
    ];
    await seed([article('a1', { clusters: two })]);
    const write = jest.spyOn(database, 'write');

    expect(await updateClusterMemberships([answer('a1', [...two].reverse())])).toBe(0);

    expect(write).not.toHaveBeenCalled();
  });

  it('skips a row a prune destroyed before the writer ran', async () => {
    await seed([article('a1', { clusters: own('a1') }), article('gone', { clusters: own('gone') })]);
    await database.write(async () => (await row('gone')).destroyPermanently());

    expect(await updateClusterMemberships([answer('a1', bhopal), answer('gone', bhopal)])).toBe(1);

    expect(await idsInDb()).toEqual(['a1']);
    expect(await json('a1')).toEqual([{ clusterId: 'c-bhopal', confidence: 0.82, stableClusterId: 's-bhopal' }]);
  });
});
