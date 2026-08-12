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
    describeVerdictPresentation,
    FACT_CHECK_SEED_MESSAGE_KEY,
    isTerminalStatus,
    normalizeVerdict,
    POLL_CEILING_MS,
    POLL_INTERVAL_MS,
    PROGRESS_DELAY_MS,
    shouldShowMultipleOrganisationsCaveat,
    shouldShowProgress,
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
    it('suppresses the spinner below the delay — a just-started job', () => {
        expect(shouldShowProgress('processing', 0)).toBe(false);
        expect(shouldShowProgress('processing', PROGRESS_DELAY_MS - 1)).toBe(false);
    });

    it('shows the spinner once the wait is perceptible', () => {
        expect(shouldShowProgress('processing', PROGRESS_DELAY_MS)).toBe(true);
        expect(shouldShowProgress('processing', 10_000)).toBe(true);
    });

    it.each(['absent', 'terminal'] as const)(
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

// Pivot P8d RE-ADDS polling (server-side async job, deleted from the client in
// pivot P4 when the check briefly ran entirely on-device). These constants
// replace the old, too-short 3s/60s window — see fact-check-state.ts's own
// header for the full reasoning; this test only pins the values and the
// relationships that would silently regress the design if broken.
describe('timing constants', () => {
    it('keeps the progress delay imperceptible', () => {
        expect(PROGRESS_DELAY_MS).toBe(400);
    });

    it('polls at a sane cadence, bounded by a ceiling generous enough for a multi-round server job', () => {
        expect(POLL_INTERVAL_MS).toBeGreaterThan(0);
        expect(POLL_CEILING_MS).toBeGreaterThan(POLL_INTERVAL_MS);
        // The old ceiling this replaces was 60_000ms and was measured to be
        // too short for a job that searches, looks up ClaimReview and
        // synthesises server-side. The new one must be meaningfully larger,
        // not a cosmetic bump.
        expect(POLL_CEILING_MS).toBeGreaterThanOrEqual(60_000 * 2);
        // A whole-number poll count keeps "stop cleanly at the ceiling"
        // exact rather than landing mid-interval.
        expect(POLL_CEILING_MS % POLL_INTERVAL_MS).toBe(0);
    });

    it('exposes the seed-message key the tick and the chat starter chip share', () => {
        expect(typeof FACT_CHECK_SEED_MESSAGE_KEY).toBe('string');
        expect(FACT_CHECK_SEED_MESSAGE_KEY.length).toBeGreaterThan(0);
    });
});

// describeVerdictPresentation — pivot P8h. The server can now legitimately
// write `verdict: 'unverifiable'` alongside a POPULATED `checkedBy` (the
// re-check path: nothing found day 0, clamped; a fact-checker publishes day
// 2, checkedBy fills in, the verdict is deliberately not re-opened). A real
// screenshot caught the sibling bug — a confident verdict chip sitting next
// to "no organisation has published" — and this is the same contradiction
// shape one hop later: "couldn't confirm" next to a named organisation's own
// ruling reads as us not knowing something we plainly do.
describe('describeVerdictPresentation', () => {
    it('leads with our own verdict when nobody has published — the normal ~96% case, unchanged', () => {
        expect(describeVerdictPresentation('supported', 0)).toBe('lead');
        expect(describeVerdictPresentation('unverifiable', 0)).toBe('lead');
        expect(describeVerdictPresentation(null, 0)).toBe('lead');
    });

    // ── THE MUST-FAIL CASE ──────────────────────────────────────────────────
    // A row that is `unverifiable` WITH a populated checkedBy must never
    // present as though nothing is known — "suppressed" is the only correct
    // answer, because "couldn't confirm" is factually wrong once an
    // organisation HAS ruled, not merely unhelpful.
    it('SUPPRESSES our own verdict when it is unverifiable and an organisation has ruled', () => {
        expect(describeVerdictPresentation('unverifiable', 1)).toBe('suppressed');
        expect(describeVerdictPresentation('UNVERIFIABLE', 3)).toBe('suppressed');
        expect(describeVerdictPresentation('  unverifiable  ', 1)).toBe('suppressed');
    });

    it('demotes (never hides) a non-unverifiable verdict once an organisation has ruled — informational, not competing', () => {
        expect(describeVerdictPresentation('supported', 1)).toBe('secondary');
        expect(describeVerdictPresentation('disputed', 2)).toBe('secondary');
        expect(describeVerdictPresentation('mixed', 1)).toBe('secondary');
        expect(describeVerdictPresentation('unsupported', 1)).toBe('secondary');
    });

    it('never returns "lead" once checkedBy is populated, whatever the verdict — two verdicts at equal weight is the contradiction this function exists to prevent', () => {
        const verdicts = ['supported', 'disputed', 'unsupported', 'mixed', 'unverifiable', 'some-unrecognised-token', null, undefined];
        for (const v of verdicts) {
            expect(describeVerdictPresentation(v, 1)).not.toBe('lead');
        }
    });

    it('treats an unrecognised verdict token as non-unverifiable (secondary, not suppressed) once checkedBy is populated', () => {
        // normalizeVerdict buckets anything undocumented as 'unknown', which
        // is NOT 'unverifiable' — an unrecognised token must not silently
        // gain the suppression behaviour reserved for the one documented
        // zero-evidence bucket.
        expect(describeVerdictPresentation('mostly-true-ish', 1)).toBe('secondary');
    });
});

describe('shouldShowMultipleOrganisationsCaveat', () => {
    it('is false for zero or one organisation — nothing to disambiguate', () => {
        expect(shouldShowMultipleOrganisationsCaveat(0)).toBe(false);
        expect(shouldShowMultipleOrganisationsCaveat(1)).toBe(false);
    });

    it('is true for two or more — never invent a consensus among them', () => {
        expect(shouldShowMultipleOrganisationsCaveat(2)).toBe(true);
        expect(shouldShowMultipleOrganisationsCaveat(5)).toBe(true);
    });
});
