// ux2 H: the chat bug report. The transcript is the one place the E2EE chat
// leaves the device readable, and only on the user's own Send.

type Hook = (event: unknown, hint: { attachments?: { filename: string; data: string }[] }) => void;
const mockHooks: Hook[] = [];
jest.mock('@sentry/react-native', () => ({
  getClient: () => ({
    on: (_name: string, cb: Hook) => {
      mockHooks.push(cb);
      return () => {
        const i = mockHooks.indexOf(cb);
        if (i >= 0) mockHooks.splice(i, 1);
      };
    },
  }),
}));
let mockSentryEnabled = true;
jest.mock('@/lib/sentry-init', () => ({
  get SENTRY_ENABLED() {
    return mockSentryEnabled;
  },
}));

import { useFeedbackStore } from '@/lib/stores/feedback-store';
import { buildChatTranscript, openChatBugReport } from '../chat-bug-report';
import type { ChatThreadItem } from '../types';

/** What Sentry's captureFeedback does on Send: emits the hook with a hint,
 *  then captures with that same hint. */
function submit(): { attachments?: { filename: string; data: string }[] } {
  const hint: { attachments?: { filename: string; data: string }[] } = {};
  for (const h of [...mockHooks]) h({ type: 'feedback' }, hint);
  return hint;
}

const at = (h: number, m: number) => new Date(2026, 8, 25, h, m).getTime();

describe('buildChatTranscript', () => {
  const items: ChatThreadItem[] = [
    { kind: 'message', key: 'u1', message: { id: 'u1', role: 'user', content: 'I live in niew west Amsterdam', createdAt: at(9, 5) } },
    { kind: 'message', key: 'a1', message: { id: 'a1', role: 'assistant', content: 'Got it. </think>' } },
    {
      kind: 'agent-steps', key: 's1', collapsed: true, doneCount: 2, failedCount: 1, terminal: null, interrupted: false, changedData: true,
      steps: [
        { id: 's::leg', kind: 'leg-start', labelKey: 'agentSteps.legStart', status: 'done' },
        { id: 's::0', kind: 'tool', toolName: 'lookup_place', labelKey: 'agentSteps.lookupPlace', status: 'done' },
        { id: 's::1', kind: 'tool', toolName: 'saveExtractedFacts', labelKey: 'agentSteps.writeUp', status: 'error' },
      ],
    },
    {
      kind: 'fact-choice-card', key: 'c1', resultKey: 'a1::0', baseResult: {}, groupIndex: 0, groupId: 'g0',
      options: ['Lives in Nieuw-West, Amsterdam', 'Lives in Amsterdam'], questionnaireAttribute: null,
      replacesFactId: null, topicSkillId: null, dismissed: false, stale: false,
    } as ChatThreadItem,
    { kind: 'ask-choice-card', key: 'q1', question: 'Which Newcastle?', options: ['Upon Tyne', 'Under Lyme'], saveAll: null, saveAsWritten: null, answered: false },
    { kind: 'fact-card', key: 'f1', action: 'deleted', statements: ['From India'], factIds: [] },
  ];

  it('gives each line a time, a role and the text, with reasoning tags stripped', () => {
    const text = buildChatTranscript(items);
    const lines = text.split('\n');
    expect(lines[0]).toBe('09:05 You: I live in niew west Amsterdam');
    // The reply carries its turn's time forward.
    expect(lines[1]).toBe('09:05 Mera: Got it.');
    expect(text).not.toMatch(/think/);
  });

  it('includes the tool steps shown, the cards and their contents', () => {
    const text = buildChatTranscript(items);
    expect(text).toContain('Mera steps: lookup_place (done), saveExtractedFacts (error)');
    expect(text).toContain('Mera card, offer: Lives in Nieuw-West, Amsterdam | Lives in Amsterdam');
    expect(text).toContain('Mera asked: Which Newcastle? [Upon Tyne | Under Lyme]');
    expect(text).toContain('Mera card, deleted: From India');
  });
});

describe('openChatBugReport', () => {
  beforeEach(() => {
    mockHooks.length = 0;
    mockSentryEnabled = true;
    useFeedbackStore.getState().hide();
  });

  it('opens the report form with the disclosure line', () => {
    openChatBugReport('09:05 You: hi', 'Your chat with Mera will be attached to this report.');
    expect(useFeedbackStore.getState().visible).toBe(true);
    expect(useFeedbackStore.getState().attachmentNote).toBe('Your chat with Mera will be attached to this report.');
  });

  it('attaches the transcript to the report the user SENDS', () => {
    openChatBugReport('09:05 You: hi', 'note');
    const hint = submit();
    expect(hint.attachments).toEqual([
      expect.objectContaining({ filename: 'chat-transcript.txt', data: '09:05 You: hi', contentType: 'text/plain' }),
    ]);
  });

  it('Cancel sends nothing and leaves no hook behind', () => {
    openChatBugReport('09:05 You: hi', 'note');
    useFeedbackStore.getState().hide();
    expect(mockHooks).toHaveLength(0);
    expect(useFeedbackStore.getState().attachmentNote).toBeNull();
  });

  it('a second, ordinary report after the chat one carries NO transcript', () => {
    openChatBugReport('09:05 You: hi', 'note');
    submit();
    useFeedbackStore.getState().hide();
    useFeedbackStore.getState().show();
    expect(submit().attachments).toBeUndefined();
    expect(useFeedbackStore.getState().attachmentNote).toBeNull();
  });

  it('with Sentry off, nothing opens and nothing is left registered', () => {
    mockSentryEnabled = false;
    openChatBugReport('09:05 You: hi', 'note');
    expect(useFeedbackStore.getState().visible).toBe(false);
    expect(mockHooks).toHaveLength(0);
  });
});
