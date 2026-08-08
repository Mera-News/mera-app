// fact-check-state — the pure vocabulary/copy layer. Every server string here
// is an un-enumerated `String` in the GraphQL schema, so the unknown buckets
// are the cases that actually matter: a model emitting a token this build has
// never seen must land on hedged generic copy, never on a blank row or a raw
// token.

import {
    describeAssessment,
    describeVerdict,
    isTerminalStatus,
    normalizeVerdict,
    POLL_INTERVAL_MS,
    POLL_TIMEOUT_MS,
    PROGRESS_DELAY_MS,
    shouldShowProgress,
    timeoutCopyKey,
} from '../fact-check-state';

describe('isTerminalStatus', () => {
    it.each(['complete', 'blocked', 'COMPLETE', ' blocked '])('is terminal: %s', (s) => {
        expect(isTerminalStatus(s)).toBe(true);
    });

    it.each(['pending', 'running', '', 'weird'])('is not terminal: %s', (s) => {
        expect(isTerminalStatus(s)).toBe(false);
    });

    it('does NOT treat failed as terminal — the server fails over between models', () => {
        expect(isTerminalStatus('failed')).toBe(false);
    });

    it('handles absent input', () => {
        expect(isTerminalStatus(null)).toBe(false);
        expect(isTerminalStatus(undefined)).toBe(false);
    });
});

describe('normalizeVerdict', () => {
    it.each([
        'supported', 'disputed', 'unsupported', 'mixed', 'unverifiable',
    ])('passes through the documented verdict %s', (v) => {
        expect(normalizeVerdict(v)).toBe(v);
    });

    it('is case- and whitespace-insensitive', () => {
        expect(normalizeVerdict('  MIXED ')).toBe('mixed');
    });

    it.each([null, undefined, '', 'true', 'false', 'mostly true', 42])(
        'falls back to unknown for %p',
        (v) => {
            expect(normalizeVerdict(v as never)).toBe('unknown');
        },
    );
});

describe('describeVerdict', () => {
    it('returns namespaced label/detail keys and a tone', () => {
        expect(describeVerdict('disputed')).toEqual({
            verdict: 'disputed',
            labelKey: 'factCheck.verdict.disputed.label',
            detailKey: 'factCheck.verdict.disputed.detail',
            tone: 'caution',
        });
    });

    it('routes an unrecognised verdict to the hedged unknown copy, neutral tone', () => {
        const info = describeVerdict('probably-fine');
        expect(info.verdict).toBe('unknown');
        expect(info.labelKey).toBe('factCheck.verdict.unknown.label');
        expect(info.tone).toBe('neutral');
    });

    it('never assigns a "negative" tone — an LLM verdict must not render as a judgement', () => {
        const tones = [
            'supported', 'disputed', 'unsupported', 'mixed', 'unverifiable', 'nonsense',
        ].map((v) => describeVerdict(v).tone);
        expect(tones).toEqual(
            expect.arrayContaining(['positive', 'caution', 'neutral']),
        );
        expect(tones).not.toContain('negative');
    });

    it('reads unverifiable as neutral, not as a negative finding', () => {
        expect(describeVerdict('unverifiable').tone).toBe('neutral');
    });
});

describe('describeAssessment', () => {
    it.each([
        ['supported', 'positive'],
        ['disputed', 'caution'],
        ['unsupported', 'caution'],
        ['unverifiable', 'neutral'],
    ])('maps %s to tone %s', (raw, tone) => {
        const info = describeAssessment(raw);
        expect(info.assessment).toBe(raw);
        expect(info.labelKey).toBe(`factCheck.assessment.${raw}`);
        expect(info.tone).toBe(tone);
    });

    it('buckets anything undocumented as unknown', () => {
        expect(describeAssessment('PARTIALLY_TRUE')).toEqual({
            assessment: 'unknown',
            labelKey: 'factCheck.assessment.unknown',
            tone: 'neutral',
        });
        expect(describeAssessment(null).assessment).toBe('unknown');
        expect(describeAssessment(undefined).assessment).toBe('unknown');
    });
});

describe('shouldShowProgress', () => {
    it('suppresses the spinner below the delay — the cross-user cache hit path', () => {
        expect(shouldShowProgress('working', 0)).toBe(false);
        expect(shouldShowProgress('working', PROGRESS_DELAY_MS - 1)).toBe(false);
    });

    it('shows the spinner once the wait is perceptible', () => {
        expect(shouldShowProgress('working', PROGRESS_DELAY_MS)).toBe(true);
        expect(shouldShowProgress('working', 10_000)).toBe(true);
    });

    it.each(['idle', 'ready', 'timeout', 'error'] as const)(
        'never shows progress in phase %s',
        (phase) => {
            expect(shouldShowProgress(phase, 99_999)).toBe(false);
        },
    );
});

describe('timeoutCopyKey', () => {
    it('reports a failure when the last observation was failed', () => {
        expect(timeoutCopyKey('failed')).toBe('factCheck.failed');
        expect(timeoutCopyKey(' FAILED ')).toBe('factCheck.failed');
    });

    it('tells the reader to check back for anything still in progress', () => {
        expect(timeoutCopyKey('pending')).toBe('factCheck.stillWorking');
        expect(timeoutCopyKey('running')).toBe('factCheck.stillWorking');
        expect(timeoutCopyKey(null)).toBe('factCheck.stillWorking');
        expect(timeoutCopyKey(undefined)).toBe('factCheck.stillWorking');
    });
});

describe('timing constants', () => {
    it('polls on the documented cadence and gives up at a minute', () => {
        expect(POLL_INTERVAL_MS).toBe(3000);
        expect(POLL_TIMEOUT_MS).toBe(60_000);
        expect(PROGRESS_DELAY_MS).toBeLessThan(POLL_INTERVAL_MS);
    });
});
