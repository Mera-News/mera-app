// topic-plan-actions — Save and Discard, and what each one tells Mera.
//
// This module had NO test file before. Its asymmetry is the whole feature and is
// easy to break by symmetry-seeking tidying:
//   SAVE    → records a note, requests NO turn (the user asked for silence).
//   DISCARD → records a note AND requests a turn (a rejection is owed a reply).
//
// The ordering inside discard is also load-bearing: `discard_fact` destroys the
// fact row, so the statement must be read BEFORE the delete or the note names
// nothing at all.

const mockApplyPersonaAction = jest.fn();
jest.mock('@/lib/database/services/persona-action-executor', () => ({
  applyPersonaAction: (...args: unknown[]) => mockApplyPersonaAction(...args),
}));

const mockMarkTopicsReviewed = jest.fn();
const mockGetFacts = jest.fn();
jest.mock('@/lib/database/services/fact-service', () => ({
  markTopicsReviewed: (...args: unknown[]) => mockMarkTopicsReviewed(...args),
  getFacts: (...args: unknown[]) => mockGetFacts(...args),
}));

const mockGetByFact = jest.fn();
jest.mock('@/lib/database/services/topic-service', () => ({
  getByFact: (...args: unknown[]) => mockGetByFact(...args),
}));

// `mock`-prefixed so jest's out-of-scope guard allows the factory to close
// over it (the module is required lazily).
const mockStore = {
  setTopicPlanSettled: jest.fn(),
  setTopicPlanDiscarded: jest.fn(),
  notifyFactMutation: jest.fn(),
  addTopicPlanNote: jest.fn(),
  requestTopicPlanTurn: jest.fn(),
};
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: { getState: () => mockStore },
}));

import { discardTopicPlan, saveTopicPlan } from '../topic-plan-actions';

beforeEach(() => {
  jest.clearAllMocks();
  mockApplyPersonaAction.mockResolvedValue({ applied: true, changeLogId: 'log-1' });
  mockMarkTopicsReviewed.mockResolvedValue(undefined);
  mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'I follow Formula 1' }]);
  mockGetByFact.mockResolvedValue([
    { id: 't1', text: 'F1 race results', status: 'active' },
    { id: 't2', text: 'F1 merchandise', status: 'retired' },
  ]);
});

describe('saveTopicPlan', () => {
  it('records what was kept and what the per-row X removed', async () => {
    await saveTopicPlan('f1', 'I follow Formula 1');

    expect(mockStore.addTopicPlanNote).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'saved',
        statement: 'I follow Formula 1',
        kept: ['F1 race results'],
        removed: ['F1 merchandise'],
      }),
    );
  });

  // The user asked for silence on this path: a save is recorded for LATER turns
  // to read, and starts nothing.
  it('requests NO model turn', async () => {
    await saveTopicPlan('f1', 'I follow Formula 1');
    expect(mockStore.requestTopicPlanTurn).not.toHaveBeenCalled();
  });

  it('still marks the plan reviewed and settled', async () => {
    await saveTopicPlan('f1', 'I follow Formula 1');
    expect(mockMarkTopicsReviewed).toHaveBeenCalledWith('f1');
    expect(mockStore.setTopicPlanSettled).toHaveBeenCalledWith('f1');
  });

  it('looks the statement up when the caller has none ("Save all")', async () => {
    await saveTopicPlan('f1');
    expect(mockStore.addTopicPlanNote).toHaveBeenCalledWith(
      expect.objectContaining({ statement: 'I follow Formula 1' }),
    );
  });

  it('records no note when the durable write fails', async () => {
    mockMarkTopicsReviewed.mockRejectedValueOnce(new Error('db'));
    await expect(saveTopicPlan('f1', 'x')).rejects.toThrow();
    // Telling the model something was kept when it was not is worse than silence.
    expect(mockStore.addTopicPlanNote).not.toHaveBeenCalled();
  });

  it('survives a failed topic snapshot without losing the save', async () => {
    mockGetByFact.mockRejectedValueOnce(new Error('db'));
    await saveTopicPlan('f1', 'I follow Formula 1');
    expect(mockMarkTopicsReviewed).toHaveBeenCalled();
    expect(mockStore.addTopicPlanNote).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'saved', kept: [], removed: [] }),
    );
  });
});

describe('discardTopicPlan', () => {
  it('records the rejection AND asks Mera to reply', async () => {
    await discardTopicPlan('f1', 'I follow Formula 1');

    expect(mockStore.addTopicPlanNote).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'discarded', statement: 'I follow Formula 1' }),
    );
    expect(mockStore.requestTopicPlanTurn).toHaveBeenCalledTimes(1);
  });

  // `discard_fact` destroys the row, so a lookup after the delete finds nothing.
  it('resolves the statement BEFORE deleting the fact', async () => {
    const order: string[] = [];
    mockGetFacts.mockImplementation(async () => {
      order.push('read');
      return [{ id: 'f1', statement: 'I follow Formula 1' }];
    });
    mockApplyPersonaAction.mockImplementation(async () => {
      order.push('delete');
      return { applied: true, changeLogId: 'log-1' };
    });

    await discardTopicPlan('f1');

    expect(order).toEqual(['read', 'delete']);
    expect(mockStore.addTopicPlanNote).toHaveBeenCalledWith(
      expect.objectContaining({ statement: 'I follow Formula 1' }),
    );
  });

  it('still deletes the fact through the audited executor', async () => {
    await discardTopicPlan('f1', 'x');
    expect(mockApplyPersonaAction).toHaveBeenCalledWith(
      { action_type: 'discard_fact', factId: 'f1' },
      'user',
    );
  });

  it('settles the card even when the fact was already gone', async () => {
    mockApplyPersonaAction.mockResolvedValueOnce({ applied: false });
    await discardTopicPlan('f1', 'x');
    expect(mockStore.setTopicPlanDiscarded).toHaveBeenCalledWith('f1');
  });
});
