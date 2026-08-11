// fact-check-state — the pure vocabulary/copy layer. Every server string here
// is an un-enumerated `String` in the GraphQL schema, so the unknown buckets
// are the cases that actually matter: a model emitting a token this build has
// never seen must land on hedged generic copy, never on a blank row or a raw
// token.

import {
    describeAssessment,
    describeCheckedBy,
    describeOrganisationVerdict,
    describeVerdict,
    isTerminalStatus,
    normalizeVerdict,
    PROGRESS_DELAY_MS,
    shouldShowProgress,
} from '../fact-check-state';
import * as factCheckState from '../fact-check-state';

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

    it.each(['idle', 'ready', 'queued', 'error'] as const)(
        'never shows progress in phase %s',
        (phase) => {
            expect(shouldShowProgress(phase, 99_999)).toBe(false);
        },
    );
});

// `checkedBy` is the primary answer this feature gives: WHO published a fact
// check on this story, not what our model thinks of it. An entry with no
// organisation name cannot carry that, so it is dropped rather than rendered as
// an anonymous verdict.
describe('describeCheckedBy', () => {
    it('keeps every named organisation, in order', () => {
        const entries = [
            { organisation: 'Full Fact', url: 'https://fullfact.org/a' },
            { organisation: 'Snopes', url: 'https://snopes.com/b' },
        ];
        expect(describeCheckedBy(entries)).toEqual(entries);
    });

    it('drops entries with no usable organisation name', () => {
        const kept = { organisation: 'AFP Fact Check' };
        expect(
            describeCheckedBy([
                { organisation: '' },
                { organisation: '   ' },
                { organisation: null },
                { organisation: undefined },
                kept,
            ] as any),
        ).toEqual([kept]);
    });

    it('returns [] for an absent list — the pre-checkedBy server, and the no-coverage case', () => {
        expect(describeCheckedBy(null)).toEqual([]);
        expect(describeCheckedBy(undefined)).toEqual([]);
        expect(describeCheckedBy([])).toEqual([]);
        expect(describeCheckedBy('nope' as any)).toEqual([]);
    });
});

// A PUBLISHED organisation's rating is human editorial copy, not a model token.
// Real fact checkers rate stories "Mostly False" / "Misleading" / "Altered
// photo" — none of which are in our five-word vocabulary. Bucketing those as
// "Unclear" would not hedge the claim, it would DELETE the per-organisation
// verdict, which is the entire ask behind the checkedBy list.
describe('describeOrganisationVerdict', () => {
    it.each([
        ['supported', 'positive'],
        ['disputed', 'caution'],
        ['unsupported', 'caution'],
        ['unverifiable', 'neutral'],
    ])('localizes the recognised token %s with tone %s', (raw, tone) => {
        const info = describeOrganisationVerdict(raw);
        expect(info.isKey).toBe(true);
        expect(info.label).toBe(`factCheck.assessment.${raw}`);
        expect(info.tone).toBe(tone);
    });

    it.each(['False', 'Mostly False', 'Misleading', 'Pants on Fire', 'Altered photo'])(
        'shows a real published rating (%s) VERBATIM rather than as "Unclear"',
        (raw) => {
            const info = describeOrganisationVerdict(raw);
            expect(info.isKey).toBe(false);
            expect(info.label).toBe(raw);
            expect(info.tone).toBe('neutral');
        },
    );

    it('trims, and is case-insensitive on the tokens it does recognise', () => {
        expect(describeOrganisationVerdict('  DISPUTED ')).toEqual({
            label: 'factCheck.assessment.disputed',
            isKey: true,
            tone: 'caution',
        });
        expect(describeOrganisationVerdict('  Mostly True  ').label).toBe('Mostly True');
    });

    it('falls back to the localized unknown label only when there is no rating at all', () => {
        for (const empty of [null, undefined, '', '   ']) {
            const info = describeOrganisationVerdict(empty);
            expect(info.isKey).toBe(true);
            expect(info.label).toBe('factCheck.assessment.unknown');
            expect(info.tone).toBe('neutral');
        }
    });

    it('never assigns a tone it cannot justify to an unrecognised rating', () => {
        // "False" reads as damning, but we have no way to know an unknown
        // vocabulary's polarity — neutral is the only honest tone.
        expect(describeOrganisationVerdict('False').tone).toBe('neutral');
        expect(describeOrganisationVerdict('True').tone).toBe('neutral');
    });
});

// The old POLL_INTERVAL_MS / POLL_TIMEOUT_MS are GONE, deliberately: the client
// no longer polls and no longer invents a deadline. PROGRESS_DELAY_MS survives
// because the no-spinner-flash rule for a cross-user cache hit does.
describe('timing constants', () => {
    it('exposes only the progress delay, and keeps it imperceptible', () => {
        expect(PROGRESS_DELAY_MS).toBe(400);
        const state = factCheckState as Record<string, unknown>;
        expect(state.POLL_INTERVAL_MS).toBeUndefined();
        expect(state.POLL_TIMEOUT_MS).toBeUndefined();
        expect(state.timeoutCopyKey).toBeUndefined();
    });
});
