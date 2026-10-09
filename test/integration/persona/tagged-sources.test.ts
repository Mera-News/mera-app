// The Sources screen's tagged list (`buildTaggedSources`): preferences and subscriptions are written by the real
// services onto the in-memory DB and read back the way `useAdjustedSources` reads them, then merged.
import { buildTaggedSources } from '@/components/custom/publication-preferences/use-adjusted-sources';
import { getActive as activePreferences, upsertPreference, upsertScopePreference } from '@/lib/database/services/publication-preference-service';
import { getActive as activeSubscriptions, upsertSubscription } from '@/lib/database/services/user-publication-subscription-service';

const subscribe = (publisherId: string, publisherName: string, sourceNames: string[]) =>
    upsertSubscription({ publisherId, publisherName, countryCode: 'IND', sourceNames });

describe('buildTaggedSources', () => {
    it('merges a subscription into its publication by source name, keeps the rest apart, scopes last', async () => {
        await upsertPreference({ publicationName: 'Zeta Daily', weight: 0.5 });
        await upsertPreference({ publicationName: 'Beta Times', weight: -1 });
        await upsertScopePreference({ scopeKind: 'country', scopeValue: 'IND', label: 'India', weight: 0.5 });
        await subscribe('p1', 'Zeta Media', ['zeta  daily']);
        await subscribe('p2', 'Alpha News', ['Alpha News']);

        const { publications, scopes } = buildTaggedSources(await activePreferences(), await activeSubscriptions());

        expect(publications.map((p) => [p.displayName, p.kind, p.subscribed, p.publisherId])).toEqual([
            ['Alpha News', null, true, 'p2'],
            ['Beta Times', 'mute', false, null],
            ['Zeta Media', 'boost', true, 'p1'],
        ]);
        expect(scopes.map((s) => s.pref.publicationName)).toEqual(['India']);
    });
});
