import * as fs from 'fs';
import { buildStoryGroups, CLUSTER_CORE_CONFIDENCE_THRESHOLD, TITLE_JACCARD_DISPLAY_THRESHOLD } from '../lib/feed-grouping/story-grouping';

const raw = fs.readFileSync('logs.md', 'utf8');
const rows: any[] = [];
for (const line of raw.split('\n')) {
    const m = line.match(/feed dump chunk \d+\/\d+ (\[.*\])\s*$/);
    if (m) rows.push(...JSON.parse(m[1]));
}
const items = rows.map((r, i) => ({ id: r.articleId + ':' + i, title: r.title ?? null, clusters: r.clusters }));
const t0 = Date.now();
const groups = buildStoryGroups(items, {
    titleJaccardThreshold: TITLE_JACCARD_DISPLAY_THRESHOLD,
    clusterConfidenceThreshold: CLUSTER_CORE_CONFIDENCE_THRESHOLD,
});
const multi = groups.filter((g) => g.length > 1);
console.log(`items=${items.length} groups=${groups.length} multi=${multi.length} covering=${multi.reduce((s, g) => s + g.length, 0)} cardsSaved=${items.length - groups.length} in ${Date.now() - t0}ms`);
console.log('largest:', multi.sort((a, b) => b.length - a.length).slice(0, 3).map((g) => `n=${g.length}: ${(g[0].title ?? '').slice(0, 50)}`));
