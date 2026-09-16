// END-TO-END through the REAL pieces: handleSaveExtractedFacts stages the blob,
// mergeGroupResolution records one tap, deriveThreadItems renders the thread.
//
// factChoiceGroups.test.ts hand-builds the staged blob, which is exactly the gap
// that let a device failure through: it proves the DERIVER is right about a blob
// shaped the way I assumed, not that the handler produces that shape. This file
// chains the real handler to the real merge to the real deriver so the assumption
// cannot hide between them.

jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: jest.fn().mockResolvedValue([]),
  addFact: jest.fn(),
  updateFact: jest.fn(),
  deleteFact: jest.fn(),
}));
jest.mock('@/lib/database/services/setting-service', () => ({ getSetting: jest.fn() }));
jest.mock('@/lib/database/services/geo-derivation-service', () => ({
  runGeoDerivationSweep: jest.fn(),
}));
jest.mock('@/lib/database/services/inference-job-service', () => ({
  enqueueJob: jest.fn(),
  hasPendingJob: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/lib/database/services/topic-service', () => ({
  syncLlmTopicsForFact: jest.fn(),
  getActive: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/inference/InferenceQueue', () => ({ inferenceQueue: { notify: jest.fn() } }));
jest.mock('@/lib/llm/cloudComplete', () => ({
  cloudComplete: jest.fn(),
  cloudBatchComplete: jest.fn(),
  HEDGE_DELAY_MS: 10_000,
}));
jest.mock('@/lib/account-service', () => ({ AccountService: { updateUserConfig: jest.fn() } }));
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: { getState: () => ({ notifyFactMutation: jest.fn() }) },
}));
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => ({ processingMode: 'CLOUD' }) },
}));
jest.mock('@/lib/stores/user-store', () => ({ useUserStore: { getState: () => ({ userId: 'u1' }) } }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { handleSaveExtractedFacts } from '@/lib/chat-tools/tool-handlers';
import {
  groupIdOf,
  mergeGroupResolution,
  readPendingGroups,
} from '@/lib/chat-tools/fact-choice-resolution';
import { deriveThreadItems } from '../deriveThreadItems';
import type { ChatThreadItem } from '../types';

const MSG = 'm1';

function itemsFor(result: Record<string, unknown>): ChatThreadItem[] {
  return deriveThreadItems({
    live: [
      {
        id: MSG,
        role: 'assistant',
        // The prompt mandates text AND a tool call on every turn, so the
        // acknowledgement always rides on the same message as the cards.
        content: 'Noted. Which topics do you want in your feed most?',
        toolCalls: [
          { id: 'tc-0', name: 'saveExtractedFacts', status: 'done', input: {}, result },
        ],
      },
    ],
    history: [],
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: 'Earlier',
  });
}

const kinds = (items: ChatThreadItem[]) => items.map((i) => i.kind);

describe('real handler -> real merge -> real deriver', () => {
  it('stages two facts as two cards plus a bulk row', async () => {
    const staged = await handleSaveExtractedFacts({
      extracted_user_information: [
        'Works as a farmer in Hoorn, Netherlands, Europe',
        'Parents live in Malaga, Spain, Europe',
      ],
    });
    expect(kinds(itemsFor(staged))).toEqual([
      'message',
      'fact-choice-card',
      'fact-choice-card',
      'fact-choice-bulk-row',
    ]);
  });

  it('DEVICE REPRO: accepting card 1 keeps card 0 and shows card 1 saved', async () => {
    const staged = await handleSaveExtractedFacts({
      extracted_user_information: [
        'Works as a farmer in Hoorn, Netherlands, Europe',
        'Parents live in Malaga, Spain, Europe',
      ],
    });
    const groups = readPendingGroups(staged);
    expect(groups).toHaveLength(2);

    const merged = mergeGroupResolution(staged, groupIdOf(groups[1]), {
      status: 'saved',
      statements: ['Parents live in Malaga, Spain, Europe'],
      savedFacts: [{ id: 'f2', statement: 'Parents live in Malaga, Spain, Europe' }],
      conflicts: [],
    });

    // On the device every fact-choice node vanished and nothing replaced it.
    expect(kinds(itemsFor(merged))).toEqual([
      'message',
      'fact-choice-card',
      'fact-card',
      'chat-topics-card',
    ]);
  });

  it('DEVICE REPRO: dismissing the only card leaves a dismissed card, not a gap', async () => {
    const staged = await handleSaveExtractedFacts({
      extracted_user_information: ['Works as a farmer in Hoorn, Netherlands, Europe'],
    });
    const groups = readPendingGroups(staged);
    const merged = mergeGroupResolution(staged, groupIdOf(groups[0]), {
      status: 'dismissed',
      options: groups[0].options,
      questionnaireAttribute: null,
    });

    const items = itemsFor(merged);
    expect(kinds(items)).toEqual(['message', 'fact-choice-card']);
    const card = items.find(
      (i): i is Extract<ChatThreadItem, { kind: 'fact-choice-card' }> =>
        i.kind === 'fact-choice-card',
    );
    expect(card?.dismissed).toBe(true);
  });
});
