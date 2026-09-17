// The four geofix arms, and the property that makes their numbers mean
// anything: each one differs from the shipped prompts in exactly ONE way.
//
// `reason-v3` is the cautionary tale this file is written against. It bundled
// two rules into one arm, came back null, and the null could not be attributed
// to either rule — so the arm cost a paid run and settled nothing. These four
// are deliberately not bundled: `geo-scope-v1` changes only the shared base,
// `reason-rescore` changes only the pass-2 contract, `reason-rescore-prior`
// changes only one line of the USER message, and `rescore-demote-only` changes
// only the decode policy. The assertions below are what keeps that true as the
// prompts are edited.
import {
  GEO_SCOPE_V1_ID,
  NULL_CONTROL_ID,
  REASON_RESCORE_ID,
  REASON_RESCORE_PRIOR_ID,
  RESCORE_DEMOTE_ONLY_ID,
} from '../prompts/reason-arms';
import {
  resolvePromptVariant,
  systemPromptForSlot,
  type PromptSlot,
} from '../prompts/prompt-variants';
import {
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
  buildReasonUserMessage,
} from '../prompts/prompts';

const SHIPPED: Record<string, string> = {
  relevance: CLOUD_RELEVANCE_SYSTEM_PROMPT,
  headlineRelevance: CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
  reason: CLOUD_REASON_SYSTEM_PROMPT,
  headlineReason: CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
};
const SLOTS = Object.keys(SHIPPED) as PromptSlot[];

const armPrompt = (id: string, slot: PromptSlot) =>
  systemPromptForSlot(slot, SHIPPED[slot], resolvePromptVariant(id));

describe('geo-scope-v1', () => {
  it('reaches ALL FOUR scoring slots', () => {
    // The rule lives in the shared base, so both passes see it. A geography
    // rule the score pass obeys and the reason pass does not would hand a
    // correctly-scored article an incorrectly-reasoned sentence.
    for (const slot of SLOTS) {
      expect(armPrompt(GEO_SCOPE_V1_ID, slot)).toContain('## Article scope');
    }
  });

  it('is the ONLY difference from the shipped prompt, in every slot', () => {
    for (const slot of SLOTS) {
      const arm = armPrompt(GEO_SCOPE_V1_ID, slot);
      // Cut the inserted section back out and the shipped prompt must return
      // byte for byte. This is what stops an unrelated prompt edit riding into
      // the geo arm and being attributed to the geography rule.
      const withoutRule = arm.replace(/\n\n## Article scope\n[^\n]*/, '');
      expect(withoutRule).toBe(SHIPPED[slot]);
    }
  });

  it('states the rule the base was missing', () => {
    const p = armPrompt(GEO_SCOPE_V1_ID, 'relevance');
    expect(p).toMatch(/never `home` or `family`/);
    expect(p).toMatch(/lives in or has family in/);
    // The worked example is the actual bug: a Portuguese story, a Dutch reader.
    expect(p).toMatch(/parental-leave vote in Portugal/);
  });

  it('does not touch the pass-2 output contract', () => {
    // geo-scope-v1 is a prompt-only arm. If it started asking for an object it
    // would be two changes wearing one name.
    expect(armPrompt(GEO_SCOPE_V1_ID, 'reason')).toContain(
      'Output: single plain string, no prefixes, no markdown.',
    );
    expect(resolvePromptVariant(GEO_SCOPE_V1_ID).rescorePolicy).toBeUndefined();
    expect(resolvePromptVariant(GEO_SCOPE_V1_ID).reasonPriorScoreLine).toBeUndefined();
  });

  it('leaves the shipped prompts alone', () => {
    expect(CLOUD_REASON_SYSTEM_PROMPT).not.toContain('## Article scope');
    expect(CLOUD_RELEVANCE_SYSTEM_PROMPT).not.toContain('## Article scope');
  });
});

describe('the rescore arms', () => {
  const RESCORE_ARMS = [REASON_RESCORE_ID, REASON_RESCORE_PRIOR_ID, RESCORE_DEMOTE_ONLY_ID];

  it.each(RESCORE_ARMS)('%s asks for the object and NOT for a plain string', (id) => {
    for (const slot of ['reason', 'headlineReason'] as PromptSlot[]) {
      const p = armPrompt(id, slot);
      expect(p).toContain('Output: exactly ONE JSON object and nothing else.');
      // THE TRAP THIS PINS. `REASON_V2_RULES` is appended AFTER the task block,
      // so its trailing "single plain string" line is the LAST word in the
      // shipped prompt. Left in place it would quietly override the object
      // contract stated 2,000 characters earlier, and the failure would look
      // like a model that cannot follow instructions.
      expect(p).not.toContain('Output: single plain string');
      expect(p).not.toContain("The score is authoritative");
    }
  });

  it.each(RESCORE_ARMS)('%s keeps the promoted v2 rules, in the same order', (id) => {
    const p = armPrompt(id, 'reason');
    expect(p).toContain('## Three additional rules');
    expect(p).toContain('**1. The middle of the scale has its own register.**');
    expect(p).toContain('**3. When no listed fact really bridges, say so plainly.**');
    // The rules come after the task, as they did when the rater scored them.
    expect(p.indexOf('## Three additional rules')).toBeGreaterThan(p.indexOf('## Task'));
  });

  it('all three rescore arms share ONE system prompt', () => {
    // They differ in the user message and in the decode policy. If the prompts
    // ever diverged, a prior-line result or a demote-only result would stop
    // being attributable to the thing its name claims.
    for (const slot of ['reason', 'headlineReason'] as PromptSlot[]) {
      const first = armPrompt(REASON_RESCORE_ID, slot);
      expect(armPrompt(REASON_RESCORE_PRIOR_ID, slot)).toBe(first);
      expect(armPrompt(RESCORE_DEMOTE_ONLY_ID, slot)).toBe(first);
    }
  });

  it('builds on the SHIPPED scoring base, not the geo one', () => {
    // Otherwise a rescore result would be confounded with the geography rule
    // and neither arm could be promoted on its own evidence.
    expect(armPrompt(REASON_RESCORE_ID, 'reason')).not.toContain('## Article scope');
  });

  it('leaves the SCORE slots alone', () => {
    // Pass 1 is untouched, so the eval can compare pass 1 against the final
    // score with pass 1 meaning the same thing in every arm.
    for (const slot of ['relevance', 'headlineRelevance'] as PromptSlot[]) {
      expect(armPrompt(REASON_RESCORE_ID, slot)).toBe(SHIPPED[slot]);
    }
  });

  it('carries the policies its names claim', () => {
    expect(resolvePromptVariant(REASON_RESCORE_ID).rescorePolicy).toBeUndefined();
    expect(resolvePromptVariant(REASON_RESCORE_PRIOR_ID).rescorePolicy).toBeUndefined();
    expect(resolvePromptVariant(RESCORE_DEMOTE_ONLY_ID).rescorePolicy).toBe('demote-only');
    expect(resolvePromptVariant(REASON_RESCORE_ID).reasonPriorScoreLine).toBe('omit');
    expect(resolvePromptVariant(REASON_RESCORE_PRIOR_ID).reasonPriorScoreLine).toBe('relabel');
    expect(resolvePromptVariant(RESCORE_DEMOTE_ONLY_ID).reasonPriorScoreLine).toBe('omit');
  });
});

describe('buildReasonUserMessage — the prior-score line', () => {
  const base = {
    userContext: 'Lives in Amsterdam. Expecting a child in March.',
    articleTitle: 'Parental leave vote delayed a week',
    articleDescription: 'Portuguese parliament postpones the committee vote.',
    articleCountry: 'Portugal',
    publication: 'Diario de Noticias (Portuguese)',
    relevance: 0.82,
    relatedFacts: ['Expecting a child in March'],
    nonce: 'aaaabbbbcccc',
  };

  it('baseline is byte-identical to the shipped message', () => {
    const shipped = buildReasonUserMessage(base);
    expect(shipped.startsWith('Relevance Score: 0.82\n\nUser Context: ')).toBe(true);
    expect(buildReasonUserMessage({ ...base, promptVariant: 'baseline' })).toBe(shipped);
  });

  it('reason-rescore drops the line entirely', () => {
    const msg = buildReasonUserMessage({ ...base, promptVariant: REASON_RESCORE_ID });
    expect(msg.startsWith('User Context: ')).toBe(true);
    expect(msg).not.toContain('Relevance Score');
    expect(msg).not.toContain('0.82');
  });

  it('reason-rescore-prior keeps it, labelled as a batched first pass', () => {
    const msg = buildReasonUserMessage({ ...base, promptVariant: REASON_RESCORE_PRIOR_ID });
    expect(msg.startsWith('First-pass score (batched): 0.82\n\nUser Context: ')).toBe(true);
  });

  it('the three arms differ ONLY in that first line', () => {
    const rest = (m: string) => m.slice(m.indexOf('User Context: '));
    const shipped = rest(buildReasonUserMessage(base));
    for (const id of [REASON_RESCORE_ID, REASON_RESCORE_PRIOR_ID, RESCORE_DEMOTE_ONLY_ID]) {
      expect(rest(buildReasonUserMessage({ ...base, promptVariant: id }))).toBe(shipped);
    }
  });

  it('still carries the publication and country lines the scorer needs', () => {
    // These are what a geography judgement is made from. Dropping the prior
    // score must not drop them with it.
    const msg = buildReasonUserMessage({ ...base, promptVariant: REASON_RESCORE_ID });
    expect(msg).toContain('Publication: Diario de Noticias (Portuguese)');
    expect(msg).toContain('Portugal');
  });
});

describe('null-control', () => {
  it('resolves to the SHIPPED prompt in every slot', () => {
    // Not "equal to a copy of it" — it names no slot at all, so
    // systemPromptForSlot hands back the shipped string itself and there is
    // nothing that could drift.
    for (const slot of SLOTS) {
      expect(armPrompt(NULL_CONTROL_ID, slot)).toBe(SHIPPED[slot]);
    }
  });

  it('carries no overrides and no policy', () => {
    const spec = resolvePromptVariant(NULL_CONTROL_ID);
    expect(spec.systemPrompts).toBeUndefined();
    expect(spec.reasonPriorScoreLine).toBeUndefined();
    expect(spec.rescorePolicy).toBeUndefined();
    expect(spec.articleTextMaxLength).toBeUndefined();
  });

  it('builds the same user message as baseline, byte for byte', () => {
    const base = {
      userContext: 'Lives in Amsterdam.',
      articleTitle: 'T',
      articleDescription: 'D',
      articleCountry: 'Portugal',
      publication: 'Diario de Noticias (Portuguese)',
      relevance: 0.82,
      relatedFacts: ['f'],
      nonce: 'aaaabbbbcccc',
    };
    expect(buildReasonUserMessage({ ...base, promptVariant: NULL_CONTROL_ID })).toBe(
      buildReasonUserMessage(base),
    );
  });
});
