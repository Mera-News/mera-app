// news-harness — pure fact-conflict detection (Wave 11 U-B1).
//
// Deterministic, persona-agent-only (runs on the fact-SAVE path — NO extra LLM
// call). Given the facts just saved and the pre-existing fact bank, flags the
// pairs that look like the user CORRECTING an earlier fact about the SAME
// subject (the domain precedent is the persona prompt's DELETE-on-same-subject-
// correction rule — "I moved to Berlin, not Paris" / "I work at Stripe now, not
// Google"). Conservative by design: a false positive (nagging the user about two
// perfectly-compatible facts) is worse than a miss, so the thresholds are tight.

/** Minimal fact shape the detector needs. */
export interface FactForConflict {
  id: string;
  statement: string;
  questionnaireAttribute?: string | null;
}

export type FactConflictKind = 'attribute' | 'contradiction';

export interface FactConflict {
  /** The freshly-saved fact. */
  newFactId: string;
  newStatement: string;
  /** The pre-existing fact it appears to conflict with. */
  existingFactId: string;
  existingStatement: string;
  kind: FactConflictKind;
  /** Shared attribute key (kind 'attribute' only) — for display/debug. */
  attributeKey?: string;
  /** A naive merged statement — the editable pre-fill for the "Merge" verb. */
  suggestedMerge: string;
}

/** Lowercase + trim + collapse whitespace. */
function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Attribute KEY = the text before the first ':' (the subject), else the whole
 *  attribute. "location: residence" and "location: city" share key "location". */
function attributeKey(attr: string | null | undefined): string | null {
  if (!attr) return null;
  const trimmed = attr.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(':');
  return normalize(colon >= 0 ? trimmed.slice(0, colon) : trimmed);
}

// SINGULAR-valued attribute keys — the subjects where a NEW fact under the same
// key genuinely REPLACES the old value (you have one residence, one primary job).
// The attribute-key heuristic (Rule A) fires ONLY for these, so PLURAL subjects
// (interests, hobbies, holdings — "interest: jazz" + "interest: hiking" coexist)
// are never falsely flagged. Conservative by intent; matches the persona
// prompt's correction examples (location, profession).
const SINGULAR_KEY_TOKENS = [
  'location', 'residence', 'home', 'address', 'city', 'neighborhood',
  'profession', 'job', 'occupation', 'employer', 'workplace', 'career', 'role',
  'age', 'nationality', 'origin', 'hometown', 'birthplace',
  'marital', 'relationship',
];

/** True if a shared attribute key denotes a single-valued subject. */
function isSingularKey(key: string): boolean {
  return SINGULAR_KEY_TOKENS.some((token) => key.includes(token));
}

// Tiny stop set — the connective words that would otherwise inflate the overlap
// between two unrelated statements. Deliberately small (high-signal only).
const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'their', 'they',
  'has', 'have', 'was', 'are', 'were', 'his', 'her', 'its',
]);

/** Significant tokens: alphanumerics of length ≥ 3 that are not stop words. */
function significantTokens(statement: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalize(statement).split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOP_TOKENS.has(raw)) out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** High-overlap threshold for the attribute-less contradiction heuristic. Kept
 *  strict so near-duplicates are caught but merely-related facts are not. */
const CONTRADICTION_JACCARD = 0.6;

/** A naive editable merge pre-fill: if one statement contains the other, keep
 *  the longer; otherwise join them so no information is silently dropped. */
function naiveMerge(newStatement: string, existingStatement: string): string {
  const a = newStatement.trim();
  const b = existingStatement.trim();
  const an = normalize(a);
  const bn = normalize(b);
  if (an.includes(bn)) return a;
  if (bn.includes(an)) return b;
  return `${a}; ${b}`;
}

/**
 * Detect same-subject conflicts between the just-saved facts and the existing
 * bank. Returns at most ONE conflict per new fact (the strongest match —
 * attribute-key match is preferred over the token-overlap heuristic). Never
 * compares a fact to itself, and never flags identical statements.
 */
export function detectFactConflicts(
  newFacts: FactForConflict[],
  existingFacts: FactForConflict[],
): FactConflict[] {
  const conflicts: FactConflict[] = [];

  for (const nf of newFacts) {
    const nStatement = nf.statement.trim();
    if (!nStatement) continue;
    const nNorm = normalize(nStatement);
    const nKey = attributeKey(nf.questionnaireAttribute);
    const nTokens = significantTokens(nStatement);

    let attributeMatch: FactForConflict | null = null;
    let contradictionMatch: FactForConflict | null = null;

    for (const ef of existingFacts) {
      if (ef.id === nf.id) continue;
      const eStatement = ef.statement.trim();
      if (!eStatement) continue;
      const eNorm = normalize(eStatement);
      if (eNorm === nNorm) continue; // identical → not a conflict, a duplicate

      // Rule A — same SINGULAR attribute key, differing statements (strongest
      // signal). Gated to singular keys so plural subjects never false-positive.
      const eKey = attributeKey(ef.questionnaireAttribute);
      if (nKey && eKey && nKey === eKey && isSingularKey(nKey)) {
        attributeMatch = ef;
        break; // attribute match wins; stop scanning for this new fact
      }

      // Rule B — high token overlap (near-duplicate / restated contradiction).
      if (!contradictionMatch && jaccard(nTokens, significantTokens(eStatement)) >= CONTRADICTION_JACCARD) {
        contradictionMatch = ef;
      }
    }

    const match = attributeMatch ?? contradictionMatch;
    if (!match) continue;

    conflicts.push({
      newFactId: nf.id,
      newStatement: nStatement,
      existingFactId: match.id,
      existingStatement: match.statement.trim(),
      kind: attributeMatch ? 'attribute' : 'contradiction',
      ...(attributeMatch && nKey ? { attributeKey: nKey } : {}),
      suggestedMerge: naiveMerge(nStatement, match.statement),
    });
  }

  return conflicts;
}
