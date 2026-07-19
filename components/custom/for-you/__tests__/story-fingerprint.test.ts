import {
    clustersSignature,
    computeGroupingFingerprint,
} from '@/components/custom/for-you/story-fingerprint';
import type { ClusterMembership } from '@/lib/stores/for-you-store';

/** Minimal grouping-input row (the subset computeGroupingFingerprint reads). */
type Row = { _id: string; clusters: ClusterMembership[] };

const row = (id: string, clusters: ClusterMembership[] = []): Row => ({ _id: id, clusters });
const cm = (
    clusterId: string,
    confidence: number,
    stableClusterId: string | null = null,
): ClusterMembership => ({ clusterId, confidence, stableClusterId });

describe('clustersSignature', () => {
    it('is empty for no memberships', () => {
        expect(clustersSignature([])).toBe('');
    });

    it('encodes clusterId, stableClusterId and confidence of every membership', () => {
        expect(clustersSignature([cm('c1', 0.9, 's1')])).toBe('c1~s1~0.9;');
        // Null stable id renders as empty between the tildes.
        expect(clustersSignature([cm('c1', 0.9)])).toBe('c1~~0.9;');
    });

    it('distinguishes a confidence change (it gates cluster edges)', () => {
        expect(clustersSignature([cm('c1', 0.9)])).not.toBe(clustersSignature([cm('c1', 0.2)]));
    });

    it('distinguishes a stableClusterId change', () => {
        expect(clustersSignature([cm('c1', 0.9, 's1')])).not.toBe(
            clustersSignature([cm('c1', 0.9, 's2')]),
        );
    });
});

describe('computeGroupingFingerprint', () => {
    const base: Row[] = [
        row('a', [cm('c1', 0.8, 's1')]),
        row('b', [cm('c1', 0.8, 's1')]),
        row('c', []),
    ];

    it('is UNCHANGED when only non-grouping fields would change (score/reason)', () => {
        // The helper never reads relevance/reason/status, so a set of rows with
        // the same ids + cluster signatures fingerprints identically — this is
        // exactly the score-only / reason-only feed update that must NOT re-run
        // union-find.
        const afterScoreUpdate: Row[] = [
            row('a', [cm('c1', 0.8, 's1')]),
            row('b', [cm('c1', 0.8, 's1')]),
            row('c', []),
        ];
        expect(computeGroupingFingerprint(afterScoreUpdate)).toBe(computeGroupingFingerprint(base));
    });

    it('CHANGES when a membership is added or removed', () => {
        const added: Row[] = [
            row('a', [cm('c1', 0.8, 's1'), cm('c2', 0.5)]),
            row('b', [cm('c1', 0.8, 's1')]),
            row('c', []),
        ];
        expect(computeGroupingFingerprint(added)).not.toBe(computeGroupingFingerprint(base));
    });

    it('CHANGES when a membership confidence changes', () => {
        const reconfident: Row[] = [
            row('a', [cm('c1', 0.25, 's1')]),
            row('b', [cm('c1', 0.8, 's1')]),
            row('c', []),
        ];
        expect(computeGroupingFingerprint(reconfident)).not.toBe(computeGroupingFingerprint(base));
    });

    it('CHANGES when the visible id set changes (row added / removed)', () => {
        const removed = base.slice(0, 2);
        const appended: Row[] = [...base, row('d', [])];
        expect(computeGroupingFingerprint(removed)).not.toBe(computeGroupingFingerprint(base));
        expect(computeGroupingFingerprint(appended)).not.toBe(computeGroupingFingerprint(base));
    });

    it('CHANGES when two rows swap identity but keep the same clusters', () => {
        // _id captures the (immutable-per-id) title, so an id reorder/relabel is
        // a real grouping change, not a false match.
        const relabeled: Row[] = [
            row('a', [cm('c1', 0.8, 's1')]),
            row('X', [cm('c1', 0.8, 's1')]),
            row('c', []),
        ];
        expect(computeGroupingFingerprint(relabeled)).not.toBe(computeGroupingFingerprint(base));
    });

    it('is empty for an empty visible set', () => {
        expect(computeGroupingFingerprint([])).toBe('');
    });
});
