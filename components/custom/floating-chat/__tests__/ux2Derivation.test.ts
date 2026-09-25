// ux2 Part D: what the thread shows around a turn that asked, offered or
// skipped. Driven through the real deriver.

import { factChoiceGroupId } from '@/lib/chat-tools/fact-choice-resolution';
import type { ConversationMessage, ToolCallRecord } from '@/lib/llm/types';
import { deriveThreadItems } from '../deriveThreadItems';
import type { ChatThreadItem } from '../types';

function derive(live: ConversationMessage[], extra: Partial<Parameters<typeof deriveThreadItems>[0]> = {}) {
  return deriveThreadItems({
    live,
    history: [],
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: 'Earlier',
    turnActive: false,
    ...extra,
  });
}

const ask = (result: Record<string, unknown> | undefined): ToolCallRecord => ({
  id: 'a0',
  name: 'ask_choice',
  input: { question: 'Which part?', options: ['Nieuw-West', 'Nieuw-Oost'] },
  result,
  status: 'done',
});

function staged(statement: string, dismissed: boolean): ToolCallRecord {
  const gid = factChoiceGroupId(0, [statement]);
  return {
    id: 's0',
    name: 'saveExtractedFacts',
    input: {},
    status: 'done',
    result: {
      success: true,
      staged: true,
      factsSaved: 0,
      savedFacts: [],
      conflicts: [],
      groupResolutions: dismissed
        ? { [gid]: { status: 'dismissed', options: [statement], questionnaireAttribute: null } }
        : {},
      pendingFacts: [{ index: 0, groupId: gid, options: [statement], questionnaireAttribute: null }],
    },
  };
}

const kindsOf = (items: ChatThreadItem[]) => items.map((i) => i.kind);

describe('ux2 D4: chips render only for a question the loop accepted', () => {
  it('a refused ask_choice renders no chips', () => {
    const items = derive([
      { id: 'u1', role: 'user', content: 'I live in niew west Amsterdam' },
      { id: 'a1', role: 'assistant', content: 'Which part?', toolCalls: [ask({ error: 'Only an ambiguous place is asked here.' })] },
    ]);
    expect(kindsOf(items)).not.toContain('ask-choice-card');
  });

  it('an accepted ask_choice still renders its chips', () => {
    const items = derive([
      { id: 'u1', role: 'user', content: 'I live in Newcastle' },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [ask({ awaiting: 'user' })] },
    ]);
    expect(kindsOf(items)).toContain('ask-choice-card');
  });
});

describe('ux2 D7: a skipped card leaves once the user moves on', () => {
  it('keeps the dismissed card, with its Undo, until the next user message', () => {
    const items = derive([
      { id: 'u1', role: 'user', content: 'I live in Hoorn' },
      { id: 'a1', role: 'assistant', content: 'Offered.', toolCalls: [staged('Lives in Hoorn', true)] },
    ]);
    expect(items.filter((i) => i.kind === 'fact-choice-card')).toHaveLength(1);
  });

  it('removes it entirely once a later user message exists', () => {
    const items = derive([
      { id: 'u1', role: 'user', content: 'I live in Hoorn' },
      { id: 'a1', role: 'assistant', content: 'Offered.', toolCalls: [staged('Lives in Hoorn', true)] },
      { id: 'u2', role: 'user', content: 'thanks' },
    ]);
    expect(items.filter((i) => i.kind === 'fact-choice-card')).toHaveLength(0);
  });
});

describe('ux2 D7: no empty Done row after an ordinary turn', () => {
  it('a settled turn that staged a card shows the card and no steps box', () => {
    const items = derive([
      { id: 'u1', role: 'user', content: 'I live in Hoorn' },
      { id: 'a1', role: 'assistant', content: 'Offered.', toolCalls: [staged('Lives in Hoorn', false)] },
    ]);
    expect(kindsOf(items)).not.toContain('agent-steps');
    expect(kindsOf(items)).toContain('fact-choice-card');
  });

  it('a failed step still keeps the box', () => {
    const failed: ToolCallRecord = { id: 'x', name: 'lookup_place', input: { query: 'x' }, status: 'error' };
    const items = derive([
      { id: 'u1', role: 'user', content: 'I live in X' },
      { id: 'a1', role: 'assistant', content: 'Hmm.', toolCalls: [failed] },
    ]);
    expect(kindsOf(items)).toContain('agent-steps');
  });
});

describe('ux2 D5: "didn\'t find anything" never sits beside a card', () => {
  it('drops the no-proposal terminal when the turn produced a card', () => {
    const items = derive(
      [
        { id: 'u1', role: 'user', content: 'I live in Hoorn' },
        { id: 'a1', role: 'assistant', content: '', toolCalls: [staged('Lives in Hoorn', false)] },
      ],
      { agentTerminal: 'no-proposal' },
    );
    const box = items.find((i) => i.kind === 'agent-steps');
    expect(box === undefined || (box.kind === 'agent-steps' && box.terminal === null)).toBe(true);
  });

  it('keeps it when the turn produced nothing', () => {
    const items = derive(
      [
        { id: 'u1', role: 'user', content: 'hmm' },
        { id: 'a1', role: 'assistant', content: 'Okay.' },
      ],
      { agentTerminal: 'no-proposal' },
    );
    const box = items.find((i) => i.kind === 'agent-steps');
    expect(box && box.kind === 'agent-steps' && box.terminal).toBe('no-proposal');
  });
});

describe('ux2 owner: the bulk row includes replace cards', () => {
  it('emits a bulk row carrying each group\'s replace target', () => {
    const gid0 = factChoiceGroupId(0, ['Founder of an AI news app']);
    const gid1 = factChoiceGroupId(1, ['Building an AI news app']);
    const tc: ToolCallRecord = {
      id: 's0', name: 'saveExtractedFacts', input: {}, status: 'done',
      result: {
        success: true, staged: true, factsSaved: 0, savedFacts: [], conflicts: [], groupResolutions: {},
        pendingFacts: [
          { index: 0, groupId: gid0, options: ['Founder of an AI news app'], questionnaireAttribute: null, replaces: 'w1' },
          { index: 1, groupId: gid1, options: ['Building an AI news app'], questionnaireAttribute: null, replaces: 'w2' },
        ],
      },
    };
    const items = derive([
      { id: 'u1', role: 'user', content: 'I am building an ai news app' },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [tc] },
    ]);
    const row = items.find((i) => i.kind === 'fact-choice-bulk-row');
    expect(row && row.kind === 'fact-choice-bulk-row' && row.groups.map((g) => g.replaces)).toEqual(['w1', 'w2']);
  });
});

describe('ux2 D9: "Save as I wrote it"', () => {
  const entry = { statement: 'Lives in Zzqq', questionnaire_attribute: 'location: neighborhood/area, city, and country (preserve specifics)' };

  it('rides on an accepted question as an extra chip', () => {
    const items = derive([
      { id: 'u1', role: 'user', content: 'I live in Newcastle' },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [{ ...ask({ awaiting: 'user', saveAsWritten: entry }) }] },
    ]);
    const card = items.find((i) => i.kind === 'ask-choice-card');
    expect(card && card.kind === 'ask-choice-card' && card.saveAsWritten).toMatchObject({ resultKey: 'a1::0', entry });
  });

  it('stands alone after a lookup that placed nothing', () => {
    const tc: ToolCallRecord = { id: 'x', name: 'saveAsWritten', input: {}, status: 'done', result: { saveAsWritten: entry } };
    const items = derive([
      { id: 'u1', role: 'user', content: 'I live in Zzqq' },
      { id: 'a1', role: 'assistant', content: 'I could not find Zzqq.', toolCalls: [tc] },
    ]);
    const card = items.find((i) => i.kind === 'ask-choice-card');
    expect(card && card.kind === 'ask-choice-card' && [card.options, card.saveAsWritten?.entry]).toEqual([[], entry]);
  });

  it('once saved, shows the saved fact and its topics instead of the chip', () => {
    const tc: ToolCallRecord = {
      id: 'x', name: 'saveAsWritten', input: {}, status: 'done',
      result: { saveAsWritten: entry, saveAsWrittenSaved: [{ id: 'f9', statement: 'Lives in Zzqq' }] },
    };
    const items = derive([
      { id: 'u1', role: 'user', content: 'I live in Zzqq' },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [tc] },
    ]);
    expect(kindsOf(items)).not.toContain('ask-choice-card');
    expect(items.find((i) => i.kind === 'fact-card')).toMatchObject({ action: 'saved', statements: ['Lives in Zzqq'] });
    expect(items.find((i) => i.kind === 'chat-topics-card')).toMatchObject({ factId: 'f9' });
  });
});

describe('ux2 F1: a saved fact\'s topics card carries its guideline', () => {
  it('passes the group\'s topic skill to the chat-topics card', () => {
    const gid = factChoiceGroupId(0, ['Lives in Hoorn']);
    const tc: ToolCallRecord = {
      id: 's0', name: 'saveExtractedFacts', input: {}, status: 'done',
      result: {
        success: true, staged: true, factsSaved: 0, savedFacts: [], conflicts: [],
        groupResolutions: { [gid]: { status: 'saved', statements: ['Lives in Hoorn'], savedFacts: [{ id: 'f1', statement: 'Lives in Hoorn' }], conflicts: [] } },
        pendingFacts: [{ index: 0, groupId: gid, options: ['Lives in Hoorn'], questionnaireAttribute: null, topicSkillId: 'topics/residence' }],
      },
    };
    const items = derive([
      { id: 'u1', role: 'user', content: 'I live in Hoorn' },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [tc] },
    ]);
    expect(items.find((i) => i.kind === 'chat-topics-card')).toMatchObject({ factId: 'f1', topicSkillId: 'topics/residence' });
  });
});

describe('ux2 batch 25 F7: a refused proposal draws no card', () => {
  const propose = (result: Record<string, unknown>): ToolCallRecord => ({
    id: 'p0', name: 'proposeChanges', status: 'done', result,
    input: { explanation: 'You follow MotoGP.', expected_effects: 'More MotoGP.', actions: [{ type: 'add_fact', statement: 'Follows MotoGP' }] },
  });
  it('an {error} result renders no proposal card', () => {
    const items = derive([
      { id: 'u1', role: 'user', content: 'I also follow MotoGP' },
      { id: 'a1', role: 'assistant', content: "I'll add MotoGP.", toolCalls: [propose({ error: 'invalid action type: add_fact' })] },
    ]);
    expect(kindsOf(items)).not.toContain('proposal-card');
  });
  it('a staged result still does', () => {
    const items = derive([
      { id: 'u1', role: 'user', content: 'I also follow MotoGP' },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [propose({ staged: true })] },
    ]);
    expect(kindsOf(items)).toContain('proposal-card');
  });
});

describe('ux2 batch 25 D5: the question shows once', () => {
  const askNewcastle: ToolCallRecord = {
    id: 'a0', name: 'ask_choice', status: 'done', result: { awaiting: 'user' },
    input: { question: 'Which Newcastle is home?', options: ['Newcastle, NSW', 'Newcastle upon Tyne'] },
  };
  const card = (content: string) =>
    derive([
      { id: 'u1', role: 'user', content: 'I live in Newcastle' },
      { id: 'a1', role: 'assistant', content, toolCalls: [askNewcastle] },
    ]).find((i) => i.kind === 'ask-choice-card');

  it('drops the card title when the bubble already asks a question in other words', () => {
    const c = card('Which Newcastle did you mean?');
    expect(c && c.kind === 'ask-choice-card' && c.question).toBeNull();
  });
  it('keeps the title when the bubble asks nothing', () => {
    const c = card('Got it, Newcastle.');
    expect(c && c.kind === 'ask-choice-card' && c.question).toBe('Which Newcastle is home?');
  });
});

describe('ux2 batch 25 D6: a live search is narrated on the steps box', () => {
  const pendingTurn: ConversationMessage[] = [
    { id: 'u1', role: 'user', content: 'what is Porto Santo' },
    { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'load_skill', input: { id: 'conversation/question' }, status: 'done', result: {} }] },
  ];
  const liveRow = (waitPhase?: string) => {
    const box = derive(pendingTurn, { turnActive: true, isStreaming: true, ...(waitPhase ? { waitPhase } : {}) } as never)
      .find((i) => i.kind === 'agent-steps');
    return box && box.kind === 'agent-steps' ? box.steps[box.steps.length - 1] : null;
  };
  it('the pending row reads the search line while the search runs', () => {
    expect(liveRow('webSearch')).toMatchObject({ status: 'pending', labelKey: 'chatPhases.webSearch' });
  });
  it('and the ordinary working line otherwise', () => {
    expect(liveRow('thinking')?.labelKey).toBe('agentSteps.working');
  });
});
