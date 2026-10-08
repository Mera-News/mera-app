jest.mock('@/lib/database/index', () => {
    const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
    return makeDatabaseMock();
});

import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import { buildTaggedSources } from '../use-adjusted-sources';

const pref = (publicationName: string, weight: number, scope?: string) =>
    ({
        id: `${publicationName}-${weight}`,
        publicationName,
        weight,
        status: 'active',
        scopeKind: scope ? 'country' : null,
        scopeValue: scope ?? null,
    }) as unknown as PublicationPreferenceModel;

const sub = (publisherId: string, publisherName: string, sources: string[]) => ({
    publisherId,
    publisherName,
    countryCode: 'IND',
    sourceNamesJson: JSON.stringify(sources),
});

describe('buildTaggedSources', () => {
    it('merges a subscription into its publication by source name, keeps the rest apart, scopes last', () => {
        const { publications, scopes } = buildTaggedSources(
            [pref('Zeta Daily', 0.5), pref('Beta Times', -1), pref('India', 0.5, 'IND')],
            [sub('p1', 'Zeta Media', ['zeta  daily']), sub('p2', 'Alpha News', ['Alpha News'])],
        );
        expect(publications.map((p) => [p.displayName, p.kind, p.subscribed, p.publisherId])).toEqual([
            ['Alpha News', null, true, 'p2'],
            ['Beta Times', 'mute', false, null],
            ['Zeta Media', 'boost', true, 'p1'],
        ]);
        expect(scopes.map((s) => s.pref.publicationName)).toEqual(['India']);
    });
});
