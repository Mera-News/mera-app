// Tests for chat-tools/proposal-handlers.ts
// Mocks fact-service DB CRUD, the floating-chat store, and the topic-gen trigger.

jest.mock('../../database/services/fact-service', () => ({
  addFact: jest.fn(),
  deleteFact: jest.fn(),
  getFacts: jest.fn(() => Promise.resolve([])),
  updateFact: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../stores/floating-chat-store', () => ({
  useFloatingChatStore: {
    getState: jest.fn(() => ({ notifyFactMutation: jest.fn() })),
  },
}));
jest.mock('../tool-handlers', () => ({
  triggerTopicGeneration: jest.fn(),
}));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../feedback', () => ({
  submitFeatureRequest: jest.fn(),
}));
jest.mock('../../database/services/topic-service', () => ({
  getAllByNormalizedText: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../database/services/persona-action-executor', () => ({
  applyPersonaAction: jest.fn(() =>
    Promise.resolve({ applied: true, changeLogId: 'cl-1', summary: 'ok' }),
  ),
}));

import { executeProposalActions } from '../proposal-handlers';
import { submitFeatureRequest } from '../../feedback';
import {
  addFact,
  deleteFact,
  getFacts,
  updateFact,
} from '../../database/services/fact-service';
import { getAllByNormalizedText } from '../../database/services/topic-service';
import { applyPersonaAction } from '../../database/services/persona-action-executor';
import { ACTION_NAMES } from '../../news-harness/persona-management/action-names';
import { useFloatingChatStore } from '../../stores/floating-chat-store';
import { triggerTopicGeneration } from '../tool-handlers';
import type { ProposalAction } from '../../llm/types';

const mockGetAllByNormalizedText = getAllByNormalizedText as jest.MockedFunction<typeof getAllByNormalizedText>;
const mockApplyPersonaAction = applyPersonaAction as jest.MockedFunction<typeof applyPersonaAction>;

const mockAddFact = addFact as jest.MockedFunction<typeof addFact>;
const mockDeleteFact = deleteFact as jest.MockedFunction<typeof deleteFact>;
const mockGetFacts = getFacts as jest.MockedFunction<typeof getFacts>;
const mockUpdateFact = updateFact as jest.MockedFunction<typeof updateFact>;
const mockTriggerTopicGeneration = triggerTopicGeneration as jest.MockedFunction<typeof triggerTopicGeneration>;
const mockSubmitFeatureRequest = submitFeatureRequest as jest.MockedFunction<typeof submitFeatureRequest>;
const mockNotifyFactMutation = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFacts.mockResolvedValue([]);
  mockAddFact.mockResolvedValue({ id: 'new-fact-id', statement: '' } as never);
  mockDeleteFact.mockResolvedValue(undefined as never);
  mockUpdateFact.mockResolvedValue(undefined as never);
  mockSubmitFeatureRequest.mockReturnValue(true);
  mockGetAllByNormalizedText.mockResolvedValue([]);
  mockApplyPersonaAction.mockResolvedValue({ applied: true, changeLogId: 'cl-1', summary: 'ok' });
  (useFloatingChatStore.getState as jest.Mock).mockReturnValue({
    notifyFactMutation: mockNotifyFactMutation,
  });
});

describe('executeProposalActions — happy paths', () => {
  it('add_fact adds the fact and triggers topic generation', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f-new', statement: 'Likes AI news' } as never);

    const actions: ProposalAction[] = [{ type: 'add_fact', statement: 'Likes AI news' }];
    const result = await executeProposalActions(actions);

    expect(mockAddFact).toHaveBeenCalledWith('Likes AI news');
    expect(mockTriggerTopicGeneration).toHaveBeenCalledWith([
      { id: 'f-new', statement: 'Likes AI news' },
    ]);
    expect(result).toEqual({ applied: 1, errors: [], summaries: [], changeLogIds: [] });
  });

  it('update_fact updates the statement of an existing fact', async () => {
    mockGetFacts.mockResolvedValueOnce([{ id: 'f1', statement: 'old' } as never]);

    const result = await executeProposalActions([
      { type: 'update_fact', fact_id: 'f1', new_statement: 'new statement' },
    ]);

    expect(mockUpdateFact).toHaveBeenCalledWith('f1', { statement: 'new statement' });
    expect(result).toEqual({ applied: 1, errors: [], summaries: [], changeLogIds: [] });
  });

  it('delete_fact deletes an existing fact', async () => {
    mockGetFacts.mockResolvedValueOnce([{ id: 'f1', statement: 'gone soon' } as never]);

    const result = await executeProposalActions([{ type: 'delete_fact', fact_id: 'f1' }]);

    expect(mockDeleteFact).toHaveBeenCalledWith('f1');
    expect(result).toEqual({ applied: 1, errors: [], summaries: [], changeLogIds: [] });
  });

  it('add_topics merges and dedupes topics onto the fact metadata', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 's', metadata: { topics: ['a', 'b'] } } as never,
    ]);

    const result = await executeProposalActions([
      { type: 'add_topics', fact_id: 'f1', topics: ['b', 'c'] },
    ]);

    expect(mockUpdateFact).toHaveBeenCalledWith('f1', {
      metadata: { topics: ['a', 'b', 'c'] },
    });
    expect(result).toEqual({ applied: 1, errors: [], summaries: [], changeLogIds: [] });
  });

  it('remove_topics drops matching topics; a non-existent topic is a no-op', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 's', metadata: { topics: ['a', 'b', 'c'] } } as never,
    ]);

    const result = await executeProposalActions([
      { type: 'remove_topics', fact_id: 'f1', topics: ['b', 'zzz'] },
    ]);

    expect(mockUpdateFact).toHaveBeenCalledWith('f1', {
      metadata: { topics: ['a', 'c'] },
    });
    expect(result).toEqual({ applied: 1, errors: [], summaries: [], changeLogIds: [] });
  });

  it('notifies fact mutation once after all actions', async () => {
    mockGetFacts.mockResolvedValueOnce([{ id: 'f1', statement: 'x' } as never]);

    await executeProposalActions([{ type: 'delete_fact', fact_id: 'f1' }]);

    expect(mockNotifyFactMutation).toHaveBeenCalledTimes(1);
  });
});

describe('executeProposalActions — submit_feature_request', () => {
  it('calls submitFeatureRequest with the title/summary and applies on success', async () => {
    const result = await executeProposalActions([
      { type: 'submit_feature_request', title: 'Dark mode widgets', summary: 'Add a dark widget option.' },
    ]);

    expect(mockSubmitFeatureRequest).toHaveBeenCalledWith('Dark mode widgets', 'Add a dark widget option.');
    expect(result).toEqual({ applied: 1, errors: [], summaries: [], changeLogIds: [] });
  });

  it('records an error when submitFeatureRequest returns false (Sentry disabled)', async () => {
    mockSubmitFeatureRequest.mockReturnValueOnce(false);

    const result = await executeProposalActions([
      { type: 'submit_feature_request', title: 'Dark mode widgets', summary: 'Add a dark widget option.' },
    ]);

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('feedback submission unavailable');
  });

  it('is excluded from fact-id validation — no fact lookup, no fact-id error even with an empty fact store', async () => {
    mockGetFacts.mockResolvedValueOnce([]);

    const result = await executeProposalActions([
      { type: 'submit_feature_request', title: 'Dark mode widgets', summary: 'Add a dark widget option.' },
    ]);

    expect(mockUpdateFact).not.toHaveBeenCalled();
    expect(mockDeleteFact).not.toHaveBeenCalled();
    expect(result.errors).toHaveLength(0);
    expect(result.applied).toBe(1);
  });
});

describe('executeProposalActions — missing fact_id', () => {
  it('reports a descriptive error for an unknown update_fact id and applies nothing', async () => {
    mockGetFacts.mockResolvedValueOnce([]);

    const result = await executeProposalActions([
      { type: 'update_fact', fact_id: 'missing', new_statement: 'x' },
    ]);

    expect(mockUpdateFact).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('missing');
  });

  it('reports errors for missing ids across delete/add_topics/remove_topics', async () => {
    mockGetFacts.mockResolvedValueOnce([]);

    const result = await executeProposalActions([
      { type: 'delete_fact', fact_id: 'a' },
      { type: 'add_topics', fact_id: 'b', topics: ['t'] },
      { type: 'remove_topics', fact_id: 'c', topics: ['t'] },
    ]);

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(3);
  });
});

describe('executeProposalActions — partial failure', () => {
  it('runs the valid actions and collects an error for the invalid one', async () => {
    mockGetFacts.mockResolvedValueOnce([{ id: 'f1', statement: 'exists' } as never]);
    mockAddFact.mockResolvedValueOnce({ id: 'f-new', statement: 'Added fact' } as never);

    const result = await executeProposalActions([
      { type: 'add_fact', statement: 'Added fact' },
      { type: 'delete_fact', fact_id: 'nope' }, // missing → error
      { type: 'update_fact', fact_id: 'f1', new_statement: 'updated' }, // valid
    ]);

    expect(mockAddFact).toHaveBeenCalledWith('Added fact');
    expect(mockUpdateFact).toHaveBeenCalledWith('f1', { statement: 'updated' });
    expect(result.applied).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('nope');
  });

  it('collects an error when a DB call throws but keeps going', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 'a' } as never,
      { id: 'f2', statement: 'b' } as never,
    ]);
    mockDeleteFact
      .mockRejectedValueOnce(new Error('db boom')) // f1 throws
      .mockResolvedValueOnce(undefined as never); // f2 ok

    const result = await executeProposalActions([
      { type: 'delete_fact', fact_id: 'f1' },
      { type: 'delete_fact', fact_id: 'f2' },
    ]);

    expect(result.applied).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('db boom');
  });
});

describe('executeProposalActions — Wave-9 rails-backed actions', () => {
  it('add_negative_topic routes through the executor with source "user"', async () => {
    mockApplyPersonaAction.mockResolvedValueOnce({
      applied: true,
      changeLogId: 'cl-neg',
      summary: 'Added negative topic: Delhi crime',
    });

    const result = await executeProposalActions([
      { type: 'add_negative_topic', topicText: 'Delhi crime' },
    ]);

    expect(mockApplyPersonaAction).toHaveBeenCalledWith(
      { action_type: ACTION_NAMES.ADD_NEGATIVE_TOPIC, topicText: 'Delhi crime' },
      'user',
    );
    expect(result.applied).toBe(1);
    expect(result.summaries).toEqual(['Added negative topic: Delhi crime']);
    expect(result.changeLogIds).toEqual(['cl-neg']);
    expect(result.errors).toEqual([]);
  });

  it('set_publication_pref maps publication NAME + pref to the executor', async () => {
    mockApplyPersonaAction.mockResolvedValueOnce({
      applied: true,
      changeLogId: 'cl-pub',
      summary: 'Set publication preference: Times of India → mute',
    });

    await executeProposalActions([
      { type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' },
    ]);

    expect(mockApplyPersonaAction).toHaveBeenCalledWith(
      {
        action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
        publicationId: 'Times of India',
        publicationPref: 'mute',
      },
      'user',
    );
  });

  it('add_suppression forwards pattern (+ optional strength/keywords)', async () => {
    await executeProposalActions([
      {
        type: 'add_suppression',
        suppressionPattern: 'lottery results',
        suppressionKeywords: ['lottery'],
        suppressionStrength: 0.9,
      },
    ]);

    expect(mockApplyPersonaAction).toHaveBeenCalledWith(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'lottery results',
        suppressionKeywords: ['lottery'],
        suppressionStrength: 0.9,
      },
      'user',
    );
  });

  it('set_topic_weight resolves the topic TEXT to an active id, then nudges', async () => {
    mockGetAllByNormalizedText.mockResolvedValueOnce([
      { id: 't-retired', status: 'retired', weight: 0.9 } as never,
      { id: 't-active', status: 'active', weight: 0.4 } as never,
    ]);
    mockApplyPersonaAction.mockResolvedValueOnce({
      applied: true,
      summary: 'Nudged topic weight to 0.10',
    });

    const result = await executeProposalActions([
      { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
    ]);

    expect(mockApplyPersonaAction).toHaveBeenCalledWith(
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't-active', delta: -0.3 },
      'user',
    );
    expect(result.applied).toBe(1);
  });

  it('set_high_priority errors (no executor call) when the topic text has no active topic', async () => {
    mockGetAllByNormalizedText.mockResolvedValueOnce([]);

    const result = await executeProposalActions([
      { type: 'set_high_priority', topicText: 'unknown topic', highPriority: true },
    ]);

    expect(mockApplyPersonaAction).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('no active topic');
  });

  it('surfaces a non-applied executor result as an error (e.g. budget exhausted)', async () => {
    mockGetAllByNormalizedText.mockResolvedValueOnce([
      { id: 't-active', status: 'active', weight: 0.4 } as never,
    ]);
    mockApplyPersonaAction.mockResolvedValueOnce({
      applied: false,
      summary: 'Nudge budget exhausted; topic weight unchanged',
    });

    const result = await executeProposalActions([
      { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
    ]);

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('budget exhausted');
  });
});
