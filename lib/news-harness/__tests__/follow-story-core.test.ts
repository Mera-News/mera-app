// follow-story core tests — the PURE brain behind the article-less "follow a
// story" chat (prompt, <context>, tool schema, origin subject).

import {
  FOLLOW_STORY_SURFACE,
  buildFollowStoryContext,
  buildFollowStorySystemPrompt,
  getFollowStoryToolDefinitions,
  makeFollowStorySubject,
} from '../follow-story';
import type { StagedProposal } from '../core/types';

const NOW = Date.parse('2026-08-07T11:00:00.000Z');

const trackProposal = (labels: string[]): StagedProposal => ({
  id: 'p-1',
  explanation: '',
  expectedEffects: '',
  chooseOne: labels.length > 1,
  actions: labels.map((label) => ({
    type: 'track_story' as const,
    label,
    searchText: label.toLowerCase(),
    subject: makeFollowStorySubject(),
  })),
});

describe('buildFollowStorySystemPrompt', () => {
  it('states the article-less framing and the 3–4 widening scopes rule', () => {
    const prompt = buildFollowStorySystemPrompt({ needsToolFormat: false });

    expect(prompt).toContain('NO article');
    expect(prompt).toContain('3–4 scope OPTIONS');
    expect(prompt).toContain('proposeTrack');
  });

  it('pins the conversational language when one is given', () => {
    expect(buildFollowStorySystemPrompt({ needsToolFormat: false, languageName: 'Hindi' }))
      .toContain('**Hindi**');
    // Scope text is retrieval input against an English corpus — never localized.
    expect(buildFollowStorySystemPrompt({ needsToolFormat: false, languageName: 'Hindi' }))
      .toContain('stay English');
  });

  it('appends the XML tool-call block only for the local path', () => {
    expect(buildFollowStorySystemPrompt({ needsToolFormat: true })).toContain('<tool_call>');
    expect(buildFollowStorySystemPrompt({ needsToolFormat: false })).not.toContain('<tool_call>');
  });

  // Precision rules. These pull in the OPPOSITE direction from "keep the scope
  // generic so it stays matchable", so they are pinned explicitly: an edit that
  // widens the scope must not take the place anchor or the capitals with it.
  it('keeps the place anchor in the search for a single localised incident', () => {
    const prompt = buildFollowStorySystemPrompt({ needsToolFormat: false });
    expect(prompt).toContain('ONE incident in ONE place');
    expect(prompt).toContain('venue, street, building or town name');
    expect(prompt).toContain('A place is not a date');
  });

  it('mandates sentence case with capitals, and never lowercase, for the search', () => {
    // The server's geo gate detects a place by its uppercase first letter, so a
    // lowercase-mandated query is silently un-geo-filterable. Do not "tidy" the
    // prompt back to "a plain lowercase retrieval query".
    const prompt = buildFollowStorySystemPrompt({ needsToolFormat: true });
    expect(prompt).toContain('KEEP THE CAPITALS');
    expect(prompt).toContain('recognises a place by its capital letter');
    expect(prompt).not.toMatch(/plain lowercase|lowercase (search|retrieval) query/);
    // The worked example has to obey its own rule or the model copies its case.
    expect(prompt).toContain('"search": "Russia Ukraine war"');
  });

  // The card is the consent gate — the prompt must not invite a typed "yes".
  it('does not offer applyProposal anywhere', () => {
    expect(buildFollowStorySystemPrompt({ needsToolFormat: true })).not.toContain('applyProposal');
  });
});

describe('buildFollowStoryContext', () => {
  it('renders the injected clock as a UTC date anchor (never reads the clock)', () => {
    expect(buildFollowStoryContext({ nowMs: NOW, proposal: null })).toContain('Today: 2026-08-07');
  });

  it('degrades to "unknown" rather than throwing on a non-finite clock', () => {
    expect(buildFollowStoryContext({ nowMs: Number.NaN, proposal: null }))
      .toContain('Today: unknown');
  });

  it('omits the pending block entirely when no card is staged', () => {
    const context = buildFollowStoryContext({ nowMs: NOW, proposal: null });

    expect(context).not.toContain('PENDING SCOPE CARD');
    expect(context.startsWith('<context>')).toBe(true);
    expect(context.endsWith('</context>')).toBe(true);
  });

  it('lists the staged pill labels so a decline can be resolved one-shot', () => {
    const context = buildFollowStoryContext({
      nowMs: NOW,
      proposal: trackProposal(['Ukraine War', 'European Security']),
    });

    expect(context).toContain('PENDING SCOPE CARD');
    expect(context).toContain('Ukraine War; European Security');
    expect(context).toContain('cancelProposal');
  });

  it('ignores a proposal that stages no actions', () => {
    const context = buildFollowStoryContext({ nowMs: NOW, proposal: trackProposal([]) });

    expect(context).not.toContain('PENDING SCOPE CARD');
  });

  // Non-track actions can't reach this surface, but a block naming no scopes
  // ("offering: .") would be worse than no block, so the gate is on the labels.
  it('truncates an over-long pill label rather than blowing the token budget', () => {
    const long = `${'Very Long Scope Label '.repeat(10)}End`;
    const context = buildFollowStoryContext({ nowMs: NOW, proposal: trackProposal([long]) });

    const rendered = context.split('offering: ')[1].split('.\n')[0];
    expect(rendered.length).toBeLessThanOrEqual(80);
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('emits no pending block when nothing staged is a track scope', () => {
    const proposal: StagedProposal = {
      id: 'p-2',
      explanation: '',
      expectedEffects: '',
      actions: [{ type: 'add_fact', statement: 'I live in Berlin' }],
    };

    expect(buildFollowStoryContext({ nowMs: NOW, proposal })).not.toContain('PENDING SCOPE CARD');
  });
});

describe('getFollowStoryToolDefinitions', () => {
  it('offers proposeTrack + cancelProposal only', () => {
    expect(getFollowStoryToolDefinitions().map((t) => t.function.name)).toEqual([
      'proposeTrack',
      'cancelProposal',
    ]);
  });

  it('requires both label and search on every option', () => {
    const propose = getFollowStoryToolDefinitions()[0].function;
    const options = (propose.parameters as any).properties.options;

    expect(propose.parameters.required).toEqual(['options']);
    expect(options.items.required).toEqual(['label', 'search']);
  });

  it('carries the case rule on the CLOUD path too', () => {
    // The system prompt is the LOCAL path's carrier. The cloud path reads this
    // schema instead, so the rule has to be stated in both or half the installed
    // base keeps emitting lowercase searches the geo gate cannot filter.
    const options = (getFollowStoryToolDefinitions()[0].function.parameters as any).properties
      .options;
    expect(options.items.properties.search.description).toContain('KEEP their capitals');
    expect(options.items.properties.search.description).not.toMatch(/lowercase/);
  });
});

describe('makeFollowStorySubject', () => {
  it('is an empty origin snapshot stamped with the followed-stories surface', () => {
    expect(makeFollowStorySubject()).toEqual({
      origin: 'article',
      surface: FOLLOW_STORY_SURFACE,
      articleId: '',
      title: '',
      pubDate: null,
      stableClusterId: null,
      publicationName: null,
    });
  });
});
