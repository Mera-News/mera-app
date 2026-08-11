// fact-check core tests — the PURE brain behind the "fact-check this" chat
// (prompt, <context>, tool schema, article subject, option parsing, staging).

import {
  FACT_CHECK_SURFACE,
  buildFactCheckContext,
  buildFactCheckSystemPrompt,
  decideProposeFactCheck,
  getFactCheckToolDefinitions,
  makeFactCheckSubject,
  parseFactCheckClaimOptions,
} from '../fact-check';
import type { StagedProposal } from '../core/types';

const NOW = Date.parse('2026-08-11T11:00:00.000Z');

const ARTICLE = {
  articleId: 'a-1',
  title: 'RFK Jr. says children receive 80 vaccines by age 18',
  description: 'The health secretary told a Senate hearing that the schedule has tripled since 1986.',
  url: 'https://example.com/story',
  publicationName: 'France 24',
};

const claimProposal = (labels: string[]): StagedProposal => ({
  id: 'p-1',
  explanation: '',
  expectedEffects: '',
  chooseOne: labels.length > 1,
  actions: labels.map((label) => ({
    type: 'fact_check_claim' as const,
    label,
    claim: `${label} is asserted.`,
    subject: makeFactCheckSubject(ARTICLE),
  })),
});

describe('buildFactCheckSystemPrompt', () => {
  it('states the 3–4 separately-checkable-claims rule and names the tool', () => {
    const prompt = buildFactCheckSystemPrompt({ needsToolFormat: false });

    expect(prompt).toContain('proposeFactCheck');
    expect(prompt).toContain('2–4 options');
    expect(prompt).toContain('ONE assertion per option, and ONE DATUM per card');
    // The anti-pattern the independent rater found in 11/31 cases: one fact
    // split into several pills by re-expressing it. Named concretely, with
    // worked examples, because the abstract rule ("never the same assertion
    // reworded") was already present and was violated anyway.
    expect(prompt).toContain('are ONE claim');
    expect(prompt).toContain('what NEW fact it would send to a fact-checker');
  });

  // The four rules the plan calls the deliverable. Each is load-bearing and each
  // has a distinct failure mode if it silently drops out of the prompt.
  it('forbids opinions, predictions and questions as claims', () => {
    const prompt = buildFactCheckSystemPrompt({ needsToolFormat: false });

    expect(prompt).toContain('NEVER an opinion');
    expect(prompt).toContain('a prediction about the future');
  });

  // The measured escape valve for the ~38% of the corpus that is essentially
  // never fact-checked. Two attempts to state this MORE forcefully both made the
  // model call the tool more often, not less — see the block comment above
  // buildFactCheckSystemPrompt before rewording this.
  it('tells the model to stay silent rather than manufacture a claim', () => {
    const prompt = buildFactCheckSystemPrompt({ needsToolFormat: false });

    expect(prompt).toContain('do NOT call proposeFactCheck');
    expect(prompt).toContain('Never manufacture a controversy');
  });

  it('requires each claim to be self-contained (searchable without the article)', () => {
    const prompt = buildFactCheckSystemPrompt({ needsToolFormat: false });

    expect(prompt).toContain('WITHOUT ever seeing this article');
    expect(prompt).toContain('never "he", "the report"');
  });

  it('handles the headline-only article explicitly', () => {
    expect(buildFactCheckSystemPrompt({ needsToolFormat: false })).toContain(
      'If the summary is missing and you only have the headline',
    );
  });

  it('accepts a claim the user types themselves as a single option', () => {
    expect(buildFactCheckSystemPrompt({ needsToolFormat: false })).toContain(
      'If the user types a claim of their own',
    );
  });

  // Mera must never pre-empt the runner's verdict — that would be a fabricated
  // all-clear rendered as chat prose, which no downstream state can correct.
  it('forbids the model from ruling on a claim itself', () => {
    const prompt = buildFactCheckSystemPrompt({ needsToolFormat: false });

    expect(prompt).toContain('You do NOT decide whether anything is true');
  });

  it('pins the conversational language while keeping claims English', () => {
    const prompt = buildFactCheckSystemPrompt({ needsToolFormat: false, languageName: 'Hindi' });

    expect(prompt).toContain('**Hindi**');
    // The claim is the retrieval key sent to ClaimReview/web search, whose
    // corpora are overwhelmingly English — a translated claim simply misses.
    expect(prompt).toContain('stay ENGLISH');
  });

  it('appends the XML tool-call block only for the local path', () => {
    expect(buildFactCheckSystemPrompt({ needsToolFormat: true })).toContain('<tool_call>');
    expect(buildFactCheckSystemPrompt({ needsToolFormat: false })).not.toContain('<tool_call>');
  });

  it('does not offer applyProposal anywhere (the card is the consent gate)', () => {
    expect(buildFactCheckSystemPrompt({ needsToolFormat: true })).not.toContain('applyProposal');
  });
});

describe('buildFactCheckContext', () => {
  it('renders the injected clock as a UTC date anchor (never reads the clock)', () => {
    expect(buildFactCheckContext({ nowMs: NOW, article: ARTICLE, proposal: null })).toContain(
      'Today: 2026-08-11',
    );
  });

  it('degrades to "unknown" rather than throwing on a non-finite clock', () => {
    expect(
      buildFactCheckContext({ nowMs: Number.NaN, article: ARTICLE, proposal: null }),
    ).toContain('Today: unknown');
  });

  it('renders the headline, publication and summary', () => {
    const context = buildFactCheckContext({ nowMs: NOW, article: ARTICLE, proposal: null });

    expect(context).toContain(`Headline: ${ARTICLE.title}`);
    expect(context).toContain('Publication: France 24');
    expect(context).toContain(`Summary: ${ARTICLE.description}`);
    expect(context.startsWith('<context>')).toBe(true);
    expect(context.endsWith('</context>')).toBe(true);
  });

  // An ABSENT line reads to a model as "not relevant"; a line that says the
  // summary is unavailable is what the prompt's headline-only rule keys on.
  it('says the summary is missing rather than omitting the line', () => {
    const context = buildFactCheckContext({
      nowMs: NOW,
      article: { articleId: 'a-2', title: 'Something happened' },
      proposal: null,
    });

    expect(context).toContain('Summary: NONE');
    expect(context).toContain('headline only');
  });

  // Reading the article body is explicitly out of scope for this wave — the URL
  // must not be offered to the model as something it could fetch.
  it('never puts the article URL in the prompt', () => {
    expect(buildFactCheckContext({ nowMs: NOW, article: ARTICLE, proposal: null })).not.toContain(
      ARTICLE.url,
    );
  });

  it('omits the pending block entirely when no card is staged', () => {
    expect(buildFactCheckContext({ nowMs: NOW, article: ARTICLE, proposal: null })).not.toContain(
      'PENDING CLAIM CARD',
    );
  });

  it('lists the staged pill labels so a decline can be resolved one-shot', () => {
    const context = buildFactCheckContext({
      nowMs: NOW,
      article: ARTICLE,
      proposal: claimProposal(['80 vaccines by 18', 'Schedule tripled since 1986']),
    });

    expect(context).toContain('PENDING CLAIM CARD');
    expect(context).toContain('80 vaccines by 18; Schedule tripled since 1986');
    expect(context).toContain('cancelProposal');
  });

  it('ignores a proposal that stages no actions', () => {
    expect(
      buildFactCheckContext({ nowMs: NOW, article: ARTICLE, proposal: claimProposal([]) }),
    ).not.toContain('PENDING CLAIM CARD');
  });

  it('emits no pending block when nothing staged is a claim', () => {
    const proposal: StagedProposal = {
      id: 'p-2',
      explanation: '',
      expectedEffects: '',
      actions: [{ type: 'add_fact', statement: 'I live in Berlin' }],
    };

    expect(buildFactCheckContext({ nowMs: NOW, article: ARTICLE, proposal })).not.toContain(
      'PENDING CLAIM CARD',
    );
  });

  it('truncates an over-long pill label rather than blowing the token budget', () => {
    const long = `${'Very Long Claim Label '.repeat(10)}End`;
    const context = buildFactCheckContext({
      nowMs: NOW,
      article: ARTICLE,
      proposal: claimProposal([long]),
    });

    const rendered = context.split('offering: ')[1].split('.\n')[0];
    expect(rendered.length).toBeLessThanOrEqual(80);
    expect(rendered.endsWith('…')).toBe(true);
  });
});

describe('getFactCheckToolDefinitions', () => {
  it('offers proposeFactCheck + cancelProposal only', () => {
    expect(getFactCheckToolDefinitions().map((t) => t.function.name)).toEqual([
      'proposeFactCheck',
      'cancelProposal',
    ]);
  });

  it('requires both label and claim on every option', () => {
    const propose = getFactCheckToolDefinitions()[0].function;
    const options = (propose.parameters as any).properties.options;

    expect(propose.parameters.required).toEqual(['options']);
    expect(options.items.required).toEqual(['label', 'claim']);
  });
});

describe('makeFactCheckSubject', () => {
  it('maps the article onto enqueueFactCheck’s parameter names', () => {
    expect(makeFactCheckSubject(ARTICLE)).toEqual({
      surface: FACT_CHECK_SURFACE,
      articleId: 'a-1',
      articleTitle: ARTICLE.title,
      articleUrl: ARTICLE.url,
      publicationName: 'France 24',
    });
  });

  it('omits the optional keys rather than setting them undefined', () => {
    const subject = makeFactCheckSubject({ articleId: 'a-3', title: 'T' });

    expect('articleUrl' in subject).toBe(false);
    expect('publicationName' in subject).toBe(false);
  });
});

describe('parseFactCheckClaimOptions', () => {
  it('keeps well-formed structured options in order', () => {
    expect(
      parseFactCheckClaimOptions([
        { label: 'A', claim: 'Claim A.' },
        { label: 'B', claim: 'Claim B.' },
      ]),
    ).toEqual([
      { label: 'A', claim: 'Claim A.' },
      { label: 'B', claim: 'Claim B.' },
    ]);
  });

  it('drops an option with no claim (there is nothing to check)', () => {
    expect(parseFactCheckClaimOptions([{ label: 'A' }, { label: 'B', claim: 'Claim B.' }])).toEqual([
      { label: 'B', claim: 'Claim B.' },
    ]);
  });

  it('falls back to the claim when the label is missing (display only)', () => {
    expect(parseFactCheckClaimOptions([{ claim: 'Claim A.' }])).toEqual([
      { label: 'Claim A.', claim: 'Claim A.' },
    ]);
  });

  it('tolerates a bare string option', () => {
    expect(parseFactCheckClaimOptions(['Claim A.'])).toEqual([
      { label: 'Claim A.', claim: 'Claim A.' },
    ]);
  });

  // Dedupe is by CLAIM, not label: two pills worded differently that check the
  // same sentence are one option, and the claim is what the runner keys on.
  it('dedupes by claim, case-insensitively', () => {
    expect(
      parseFactCheckClaimOptions([
        { label: 'A', claim: 'Claim A.' },
        { label: 'A restated', claim: 'CLAIM A.' },
      ]),
    ).toHaveLength(1);
  });

  it('caps at four options', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, claim: `Claim ${i}.` }));
    expect(parseFactCheckClaimOptions(many)).toHaveLength(4);
  });

  it('truncates an over-long claim and label to the hard caps', () => {
    const [option] = parseFactCheckClaimOptions([
      { label: 'x'.repeat(200), claim: 'y'.repeat(500) },
    ]);

    expect(option.label).toHaveLength(80);
    expect(option.claim).toHaveLength(300);
    expect(option.claim.endsWith('…')).toBe(true);
  });

  it('returns nothing for a non-array', () => {
    expect(parseFactCheckClaimOptions('nope')).toEqual([]);
    expect(parseFactCheckClaimOptions(undefined)).toEqual([]);
  });
});

describe('decideProposeFactCheck', () => {
  const subject = makeFactCheckSubject(ARTICLE);

  it('stages one action per option and marks ≥2 single-select', () => {
    const out = decideProposeFactCheck(
      { options: [{ label: 'A', claim: 'Claim A.' }, { label: 'B', claim: 'Claim B.' }] },
      subject,
    );

    expect(out.sideEffects?.proposal?.actions).toEqual([
      { type: 'fact_check_claim', label: 'A', claim: 'Claim A.', subject },
      { type: 'fact_check_claim', label: 'B', claim: 'Claim B.', subject },
    ]);
    expect(out.sideEffects?.proposal?.chooseOne).toBe(true);
    expect(out.result.chooseOne).toBe(true);
  });

  // The "user typed their own claim" path. A lone option is not a CHOICE, and
  // proposalRequiresUserChoice reads a one-action chooseOne as false anyway —
  // consent for this case comes from USER_CONFIRMED_ONLY_ACTIONS instead.
  it('does not mark a single option single-select', () => {
    const out = decideProposeFactCheck({ options: [{ label: 'A', claim: 'Claim A.' }] }, subject);

    expect(out.sideEffects?.proposal?.actions).toHaveLength(1);
    expect(out.sideEffects?.proposal?.chooseOne).toBeUndefined();
    expect(out.result.chooseOne).toBeUndefined();
  });

  it('tolerates a lone `claim` string instead of options', () => {
    const out = decideProposeFactCheck({ claim: 'Claim A.' }, subject);

    expect(out.sideEffects?.proposal?.actions).toHaveLength(1);
  });

  it('errors (and stages nothing) when no option survives parsing', () => {
    const out = decideProposeFactCheck({ options: [{ label: 'A' }] }, subject);

    expect(out.result.error).toBe('options is required');
    expect(out.sideEffects).toBeUndefined();
  });

  // The echo is what makes a RESUMED thread rebuild identical actions with no
  // store read — deriveFactCheckProposal reads exactly these two fields.
  it('echoes the parsed options and the subject for the resume path', () => {
    const out = decideProposeFactCheck({ options: [{ label: 'A', claim: 'Claim A.' }] }, subject);

    expect(out.result.options).toEqual([{ label: 'A', claim: 'Claim A.' }]);
    expect(out.result.subject).toEqual(subject);
    expect(typeof out.result.proposalId).toBe('string');
  });
});
