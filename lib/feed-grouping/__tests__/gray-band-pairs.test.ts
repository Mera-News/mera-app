import {
    GRAY_BAND_MAX_HAMMING,
    SIDECAR_BITS,
    cosineFromHamming,
    decodeSidecar,
    enumerateGrayBandPairs,
    grayBandSweep,
    hammingDistance,
    type DedupCandidate,
} from '../gray-band-pairs';

const SIDECAR_BYTES = SIDECAR_BITS / 8;

/** Encode bytes to base64 without depending on Buffer/btoa being present. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64[b0 >> 2];
        out += B64[((b0 & 3) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
    }
    return out;
}

/** A 96-byte sidecar that differs from all-zeros in exactly `flipped` bits. */
function sidecarWithBitsSet(flipped: number): string {
    const bytes = new Uint8Array(SIDECAR_BYTES);
    for (let i = 0; i < flipped; i += 1) bytes[i >> 3] |= 0x80 >> (i & 7);
    return toBase64(bytes);
}

const ZERO_SIDECAR = sidecarWithBitsSet(0);

function candidate(over: Partial<DedupCandidate> & { id: string }): DedupCandidate {
    return { title: null, clusters: [], ...over };
}

describe('decodeSidecar', () => {
    it('round-trips a 96-byte payload', () => {
        const bytes = new Uint8Array(SIDECAR_BYTES);
        bytes[0] = 0xab;
        bytes[95] = 0x0f;
        const decoded = decodeSidecar(toBase64(bytes));
        expect(decoded).not.toBeNull();
        expect(decoded!.length).toBe(SIDECAR_BYTES);
        expect(decoded![0]).toBe(0xab);
        expect(decoded![95]).toBe(0x0f);
    });

    it('rejects absent, empty, malformed and wrong-length payloads', () => {
        expect(decodeSidecar(null)).toBeNull();
        expect(decodeSidecar(undefined)).toBeNull();
        expect(decodeSidecar('')).toBeNull();
        // Right length, illegal character.
        const bad = `${'!'}${ZERO_SIDECAR.slice(1)}`;
        expect(decodeSidecar(bad)).toBeNull();
        // A 32-byte payload — plausible base64, wrong vector width.
        expect(decodeSidecar(toBase64(new Uint8Array(32)))).toBeNull();
    });
});

describe('hammingDistance / cosineFromHamming', () => {
    it('counts differing bits and refuses mismatched lengths', () => {
        const a = decodeSidecar(sidecarWithBitsSet(0))!;
        const b = decodeSidecar(sidecarWithBitsSet(5))!;
        expect(hammingDistance(a, b)).toBe(5);
        expect(hammingDistance(a, a)).toBe(0);
        expect(hammingDistance(a, new Uint8Array(4))).toBe(-1);
    });

    it('maps 0 / half / all bits to cos 1 / 0 / -1', () => {
        expect(cosineFromHamming(0)).toBeCloseTo(1, 10);
        expect(cosineFromHamming(SIDECAR_BITS / 2)).toBeCloseTo(0, 10);
        expect(cosineFromHamming(SIDECAR_BITS)).toBeCloseTo(-1, 10);
    });
});

describe('enumerateGrayBandPairs — vector axis', () => {
    it('emits a pair inside the band and none outside it', () => {
        const inBand = enumerateGrayBandPairs([
            candidate({ id: 'a', vectorSidecarPacked: ZERO_SIDECAR }),
            candidate({ id: 'b', vectorSidecarPacked: sidecarWithBitsSet(GRAY_BAND_MAX_HAMMING) }),
        ]);
        expect(inBand).toHaveLength(1);
        expect(inBand[0]).toMatchObject({ aId: 'a', bId: 'b', axis: 'vector', hamming: GRAY_BAND_MAX_HAMMING });

        const outOfBand = enumerateGrayBandPairs([
            candidate({ id: 'a', vectorSidecarPacked: ZERO_SIDECAR }),
            candidate({ id: 'b', vectorSidecarPacked: sidecarWithBitsSet(GRAY_BAND_MAX_HAMMING + 1) }),
        ]);
        expect(outOfBand).toHaveLength(0);
    });

    it('SKIPS a pair the propagation grouping already merged (cluster edge)', () => {
        const clusters = [{ clusterId: 'c1', confidence: 0.9, stableClusterId: null }];
        const pairs = enumerateGrayBandPairs([
            candidate({ id: 'a', clusters, vectorSidecarPacked: ZERO_SIDECAR }),
            candidate({ id: 'b', clusters, vectorSidecarPacked: sidecarWithBitsSet(10) }),
        ]);
        expect(pairs).toHaveLength(0);
    });

    it('SKIPS a pair the propagation title bar already merged', () => {
        const title = 'Praggnanandhaa wins Saint Louis Rapid Blitz title';
        const pairs = enumerateGrayBandPairs([
            candidate({ id: 'a', title, vectorSidecarPacked: ZERO_SIDECAR }),
            candidate({ id: 'b', title, vectorSidecarPacked: sidecarWithBitsSet(10) }),
        ]);
        expect(pairs).toHaveLength(0);
    });

    it('returns pairs closest-first and honours the cap', () => {
        const items = [
            candidate({ id: 'a', vectorSidecarPacked: ZERO_SIDECAR }),
            candidate({ id: 'b', vectorSidecarPacked: sidecarWithBitsSet(80) }),
            candidate({ id: 'c', vectorSidecarPacked: sidecarWithBitsSet(20) }),
        ];
        const pairs = enumerateGrayBandPairs(items);
        expect(pairs.map((p) => p.hamming)).toEqual([...pairs.map((p) => p.hamming)].sort((x, y) => (x as number) - (y as number)));
        expect(enumerateGrayBandPairs(items, { maxPairs: 1 })).toHaveLength(1);
    });
});

describe('enumerateGrayBandPairs — lexical fallback', () => {
    it('uses titles only when a sidecar is missing, inside [0.30, 0.55)', () => {
        // 3 shared / 7 union = 0.43 — inside the band, below the 0.55 bar.
        const a = 'Amsterdam kidnapping suspect arrested downtown';
        const b = 'Amsterdam kidnapping suspect questioned';
        const pairs = enumerateGrayBandPairs([
            candidate({ id: 'a', title: a }),
            candidate({ id: 'b', title: b }),
        ]);
        expect(pairs).toHaveLength(1);
        expect(pairs[0].axis).toBe('lexical');
        expect(pairs[0].hamming).toBeNull();
        expect(pairs[0].similarity).toBeGreaterThanOrEqual(0.3);
        expect(pairs[0].similarity).toBeLessThan(0.55);
    });

    it('does NOT fall back to titles when both sidecars decoded', () => {
        const a = 'Amsterdam kidnapping suspect arrested downtown';
        const b = 'Amsterdam kidnapping suspect questioned';
        const pairs = enumerateGrayBandPairs([
            candidate({ id: 'a', title: a, vectorSidecarPacked: ZERO_SIDECAR }),
            // Far apart in vector space ⇒ not a candidate, and the titles must
            // not resurrect it.
            candidate({ id: 'b', title: b, vectorSidecarPacked: sidecarWithBitsSet(400) }),
        ]);
        expect(pairs).toHaveLength(0);
    });
});

describe('grayBandSweep counters', () => {
    it('reports coverage, found-vs-sent and the closest pair', () => {
        const items = [
            candidate({ id: 'a', vectorSidecarPacked: ZERO_SIDECAR }),
            candidate({ id: 'b', vectorSidecarPacked: sidecarWithBitsSet(12) }),
            candidate({ id: 'c', title: 'a title with no vector at all here' }),
        ];
        const { counters } = grayBandSweep(items, { maxPairs: 1 });
        expect(counters.dedupCandidates).toBe(3);
        expect(counters.dedupWithSidecar).toBe(2);
        expect(counters.dedupPairsSent).toBe(1);
        expect(counters.dedupPairsVectorAxis).toBe(1);
        expect(counters.dedupClosestHamming).toBe(12);
    });

    it('counts FOUND before the cap, so a saturated sweep is visible', () => {
        // Three mutually in-band items ⇒ 3 pairs, capped to 1. `found` is the
        // only counter whose whole job is to differ from `sent`; asserting
        // `>= sent` would pass even if the cap leaked into it.
        const items = [
            candidate({ id: 'a', vectorSidecarPacked: ZERO_SIDECAR }),
            candidate({ id: 'b', vectorSidecarPacked: sidecarWithBitsSet(10) }),
            candidate({ id: 'c', vectorSidecarPacked: sidecarWithBitsSet(20) }),
        ];
        expect(grayBandSweep(items).counters.dedupPairsFound).toBe(3);
        const capped = grayBandSweep(items, { maxPairs: 1 }).counters;
        expect(capped.dedupPairsSent).toBe(1);
        expect(capped.dedupPairsFound).toBe(3);
        expect(capped.dedupPairsFound).toBeGreaterThan(capped.dedupPairsSent);
    });

    it('is empty and safe on degenerate input', () => {
        expect(enumerateGrayBandPairs([])).toEqual([]);
        expect(enumerateGrayBandPairs([candidate({ id: 'only' })])).toEqual([]);
        const { counters } = grayBandSweep([
            candidate({ id: 'a', vectorSidecarPacked: 'not-base64' }),
            candidate({ id: 'b', title: null }),
        ]);
        expect(counters.dedupWithSidecar).toBe(0);
        expect(counters.dedupPairsSent).toBe(0);
        expect(counters.dedupClosestHamming).toBe(-1);
    });
});
