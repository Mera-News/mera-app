// The geofix arms, and the property that makes their numbers mean anything:
// each one differs from the shipped prompts in exactly ONE way.
//
// `reason-v3` is the cautionary tale this file is written against. It bundled
// two rules into one arm, came back null, and the null could not be attributed
// to either rule — so the arm cost a paid run and settled nothing. These are
// deliberately not bundled: `pre-geo-control` changes only the shared base,
// `reason-rescore` changes only the pass-2 contract, `reason-rescore-prior`
// changes only one line of the USER message, and `rescore-demote-only` changes
// only the decode policy. The assertions below are what keeps that true as the
// prompts are edited.
//
// The article-scope rule itself is no longer an arm: it was promoted into the
// shared base, so the assertions that used to pin it onto an arm now pin it
// onto the SHIPPED prompts, and `pre-geo-control` is the way back.
import {
  PRE_GEO_CONTROL_ID,
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
import { undoUx1ReasonLabelRule } from './ux1-reason-label';

const SHIPPED: Record<string, string> = {
  relevance: CLOUD_RELEVANCE_SYSTEM_PROMPT,
  headlineRelevance: CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
  reason: CLOUD_REASON_SYSTEM_PROMPT,
  headlineReason: CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
};
const SLOTS = Object.keys(SHIPPED) as PromptSlot[];

const armPrompt = (id: string, slot: PromptSlot) =>
  systemPromptForSlot(slot, SHIPPED[slot], resolvePromptVariant(id));

describe('the promoted article-scope rule', () => {
  it('is in ALL FOUR shipped scoring prompts', () => {
    // The rule lives in the shared base, so both passes see it. A geography
    // rule the score pass obeys and the reason pass does not would hand a
    // correctly-scored article an incorrectly-reasoned sentence. The headline
    // pair was NOT separately measured; it rides along because splitting the
    // base is the failure this assertion exists to prevent.
    for (const slot of SLOTS) {
      expect(SHIPPED[slot]).toContain('## Article scope');
    }
  });

  it('states the rule the base was missing', () => {
    expect(CLOUD_RELEVANCE_SYSTEM_PROMPT).toMatch(/never `home` or `family`/);
    expect(CLOUD_RELEVANCE_SYSTEM_PROMPT).toMatch(/lives in or has family in/);
    // The worked example is the actual bug: a Portuguese story, a Dutch reader.
    expect(CLOUD_RELEVANCE_SYSTEM_PROMPT).toMatch(/parental-leave vote in Portugal/);
  });

  it('did not touch the pass-2 output contract on the way in', () => {
    expect(CLOUD_REASON_SYSTEM_PROMPT).toContain(
      'Output: single plain string, no prefixes, no markdown.',
    );
  });
});

describe('pre-geo-control', () => {
  it('is the shipped prompt MINUS the article-scope rule, in every slot but one', () => {
    for (const slot of SLOTS) {
      const arm = armPrompt(PRE_GEO_CONTROL_ID, slot);
      expect(arm).not.toContain('## Article scope');
      if (slot === 'headlineReason') continue;
      // Cut the promoted section out of the shipped prompt and the control must
      // return byte for byte. This is what stops an unrelated prompt edit
      // landing on one side only and being attributed to the geography rule.
      const shippedWithoutRule = undoUx1ReasonLabelRule(
        SHIPPED[slot].replace(/\n\n## Article scope\n[^\n]*/, ''),
      );
      expect(arm).toBe(shippedWithoutRule);
    }
  });

  it('differs from the shipped headline reason prompt by TWO things, named', () => {
    // The exception above, spelled out rather than waved through. The shipped
    // headline reason prompt also dropped the anchor table to fit the gateway
    // wire cap, so this arm carries the article-scope rule's ABSENCE and the
    // anchors' PRESENCE. Anyone running it on a headline bundle gets a 400,
    // because the archived string is 65944 on the wire against a 65536 cap —
    // which is exactly the bug this arm archives.
    const arm = armPrompt(PRE_GEO_CONTROL_ID, 'headlineReason');
    expect(arm).toContain('## Anchors (example user');
    expect(SHIPPED.headlineReason).not.toContain('## Anchors (example user');
    // Put the anchors back and take the rule out, and the two must meet.
    const anchors = arm.slice(
      arm.indexOf('## Anchors (example user'),
      arm.indexOf('## Priority'),
    );
    const shippedWithAnchorsNoRule = SHIPPED.headlineReason
      .replace(/\n\n## Article scope\n[^\n]*/, '')
      .replace('## Priority', `${anchors}## Priority`);
    expect(arm).toBe(shippedWithAnchorsNoRule);
  });

  it('carries no decode change, so the comparison is prompts only', () => {
    expect(resolvePromptVariant(PRE_GEO_CONTROL_ID).rescorePolicy).toBeUndefined();
    expect(resolvePromptVariant(PRE_GEO_CONTROL_ID).reasonPriorScoreLine).toBeUndefined();
  });

  it('keeps the pass-2 string contract, like the prompt it archives', () => {
    expect(armPrompt(PRE_GEO_CONTROL_ID, 'reason')).toContain(
      'Output: single plain string, no prefixes, no markdown.',
    );
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

  it('builds on the SHIPPED scoring base', () => {
    // Since the promotion that base carries the article-scope rule, so a
    // rescore arm is once again ONE change against the current default. The
    // numbers in its description were measured that way.
    expect(armPrompt(REASON_RESCORE_ID, 'reason')).toContain('## Article scope');
    expect(armPrompt(REASON_RESCORE_ID, 'reason').replace(/\n\n## Article scope\n[^\n]*/, ''))
      .not.toContain('## Article scope');
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

describe('the output example must not answer the question', () => {
  // A live probe on the DN matrix returned the wave's own bug case almost word
  // for word, because the first draft of the object contract used that article
  // as its worked example. The model was copying. Any measurement of that
  // article under a rescore arm was therefore contaminated by the prompt.
  it('never names the article the DN matrix tests', () => {
    for (const id of [REASON_RESCORE_ID, REASON_RESCORE_PRIOR_ID, RESCORE_DEMOTE_ONLY_ID]) {
      for (const slot of ['reason', 'headlineReason'] as PromptSlot[]) {
        const p = armPrompt(id, slot);
        expect(p).not.toMatch(/parental[- ]leave vote is a Portuguese/i);
        expect(p).not.toMatch(/Portugal's parental/i);
      }
    }
  });

  it('shows one HIGH and one LOW, so neither verdict is the default', () => {
    const p = armPrompt(REASON_RESCORE_ID, 'reason');
    const examples = p.slice(p.indexOf('Examples of the SHAPE'));
    expect(examples).toContain('"k":"home"');
    expect(examples).toContain('"k":"none"');
  });

  it('introduces no sentence the shipped prompt does not already carry', () => {
    // Both example reasons are lifted from the tone table, so the arm still
    // differs from the shipped prompt in its output contract and nothing else.
    const shipped = SHIPPED.reason;
    expect(shipped).toContain('Evacuation ordered in Jordaan, where you live.');
    expect(shipped).toContain("Manchester building fire is a UK-local emergency; you're in Amsterdam.");
  });
});
