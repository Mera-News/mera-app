// Tests for chat-tools/tool-handlers.ts
// Mocks every I/O dependency: DB services, stores, LLM, AccountService, InferenceQueue.

jest.mock('../../database/services/fact-service', () => ({
  addFact: jest.fn(),
  deleteFact: jest.fn(),
  getFacts: jest.fn(() => Promise.resolve([])),
  updateFact: jest.fn(() => Promise.resolve()),
  getCoveredAttributeKeys: jest.fn(() => Promise.resolve(new Set<string>())),
  getQuestionnaireLevel: jest.fn(() => Promise.resolve(1)),
  setQuestionnaireLevel: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../database/services/setting-service', () => ({
  getSetting: jest.fn(() => Promise.resolve(null)),
  setSetting: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../account-service', () => ({
  AccountService: {
    updateUserConfig: jest.fn(() => Promise.resolve()),
    issueLlmWarning: jest.fn(() => Promise.resolve()),
  },
}));
jest.mock('../../stores/floating-chat-store', () => ({
  useFloatingChatStore: {
    getState: jest.fn(() => ({ notifyFactMutation: jest.fn() })),
  },
}));
jest.mock('../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: jest.fn(() => ({ processingMode: 'CLOUD' })),
  },
}));
jest.mock('../../stores/user-store', () => ({
  useUserStore: {
    getState: jest.fn(() => ({ userId: 'user-123', setUserPersona: jest.fn() })),
  },
}));
jest.mock('../../generated/graphql-types', () => ({
  ProcessingMode: { Cloud: 'CLOUD', OnDevice: 'OnDevice' },
}));
jest.mock('../../database/services/inference-job-service', () => ({
  enqueueJob: jest.fn(() => Promise.resolve()),
  hasPendingJob: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../../inference/InferenceQueue', () => ({
  inferenceQueue: { notify: jest.fn() },
}));
jest.mock('../../llm/cloudComplete', () => ({
  cloudBatchComplete: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../mera-protocol/topic-generation-service', () => ({
  buildCloudBatchCallsForFact: jest.fn(() => []),
  mergeRealOutputsForFact: jest.fn(() => []),
}));
jest.mock('../../database/services/topic-service', () => ({
  syncLlmTopicsForFact: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../mera-protocol/questionnaire-data', () => ({
  getAttributeKeysForLevel: jest.fn(() => ['location', 'profession', 'topics']),
  TOTAL_LEVELS: 10,
  buildAttributeTextToIdMap: jest.fn(() => new Map()),
}));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), captureException: jest.fn() },
}));

import {
  handleSaveExtractedFacts,
  handleUpdateUserConfig,
  handleDeleteUserFacts,
  handleAdvanceQuestionnaireLevel,
  handleIssueWarning,
  MAX_FACT_LENGTH,
} from '../tool-handlers';
import {
  addFact,
  deleteFact,
  getFacts,
  updateFact,
  getCoveredAttributeKeys,
  getQuestionnaireLevel,
  setQuestionnaireLevel,
} from '../../database/services/fact-service';
import { getSetting, setSetting } from '../../database/services/setting-service';
import { AccountService } from '../../account-service';
import { useFloatingChatStore } from '../../stores/floating-chat-store';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { useUserStore } from '../../stores/user-store';
import { enqueueJob, hasPendingJob } from '../../database/services/inference-job-service';
import { inferenceQueue } from '../../inference/InferenceQueue';
import { cloudBatchComplete } from '../../llm/cloudComplete';
import { syncLlmTopicsForFact } from '../../database/services/topic-service';
import logger from '../../logger';

const mockSyncLlmTopicsForFact = syncLlmTopicsForFact as jest.MockedFunction<typeof syncLlmTopicsForFact>;

const mockAddFact = addFact as jest.MockedFunction<typeof addFact>;
const mockDeleteFact = deleteFact as jest.MockedFunction<typeof deleteFact>;
const mockGetFacts = getFacts as jest.MockedFunction<typeof getFacts>;
const mockUpdateFact = updateFact as jest.MockedFunction<typeof updateFact>;
const mockGetCoveredAttributeKeys = getCoveredAttributeKeys as jest.MockedFunction<typeof getCoveredAttributeKeys>;
const mockGetQuestionnaireLevel = getQuestionnaireLevel as jest.MockedFunction<typeof getQuestionnaireLevel>;
const mockSetQuestionnaireLevel = setQuestionnaireLevel as jest.MockedFunction<typeof setQuestionnaireLevel>;
const mockGetSetting = getSetting as jest.MockedFunction<typeof getSetting>;
const mockSetSetting = setSetting as jest.MockedFunction<typeof setSetting>;
const mockUpdateUserConfig = AccountService.updateUserConfig as jest.MockedFunction<typeof AccountService.updateUserConfig>;
const mockIssueLlmWarning = AccountService.issueLlmWarning as jest.MockedFunction<typeof AccountService.issueLlmWarning>;
const mockSetUserPersona = jest.fn();
const mockNotifyFactMutation = jest.fn();
const mockCloudBatchComplete = cloudBatchComplete as jest.MockedFunction<typeof cloudBatchComplete>;
const mockEnqueueJob = enqueueJob as jest.MockedFunction<typeof enqueueJob>;
const mockHasPendingJob = hasPendingJob as jest.MockedFunction<typeof hasPendingJob>;

beforeEach(() => {
  jest.clearAllMocks();
  // Default return values
  mockGetFacts.mockResolvedValue([]);
  mockAddFact.mockResolvedValue({ id: 'new-fact-id', statement: '' } as never);
  mockDeleteFact.mockResolvedValue(undefined as never);
  mockUpdateFact.mockResolvedValue(undefined as never);
  mockGetCoveredAttributeKeys.mockResolvedValue(new Set<string>());
  mockGetQuestionnaireLevel.mockResolvedValue(1);
  mockSetQuestionnaireLevel.mockResolvedValue(undefined as never);
  mockGetSetting.mockResolvedValue(null);
  mockSetSetting.mockResolvedValue(undefined as never);
  mockUpdateUserConfig.mockResolvedValue(undefined as never);
  mockCloudBatchComplete.mockResolvedValue([]);
  mockHasPendingJob.mockResolvedValue(false);
  mockEnqueueJob.mockResolvedValue({ id: 'job-id' } as never);
  mockSyncLlmTopicsForFact.mockResolvedValue([] as never);
  (useFloatingChatStore.getState as jest.Mock).mockReturnValue({ notifyFactMutation: mockNotifyFactMutation });
  (useMeraProtocolStore.getState as jest.Mock).mockReturnValue({ processingMode: 'CLOUD' });
  (useUserStore.getState as jest.Mock).mockReturnValue({ userId: 'user-123', setUserPersona: mockSetUserPersona });
});

/** Builds a UserPersona-shaped object for issueLlmWarning mock returns. */
function personaWith(overrides: Partial<Record<string, unknown>>): never {
  return {
    _id: 'persona-1',
    userId: 'user-123',
    blockedByLlm: false,
    blockedByLlmReason: null,
    llmWarningCount: 0,
    ...overrides,
  } as never;
}

// ============================================================
// MAX_FACT_LENGTH constant
// ============================================================

describe('MAX_FACT_LENGTH', () => {
  it('is exported and equals 200', () => {
    expect(MAX_FACT_LENGTH).toBe(200);
  });
});

// ============================================================
// handleSaveExtractedFacts
// ============================================================

describe('handleSaveExtractedFacts', () => {
  it('returns success with factsSaved=0 when no facts provided', async () => {
    const result = await handleSaveExtractedFacts({ extracted_user_information: [] });
    expect(result).toEqual({ success: true, factsSaved: 0, savedFacts: [], conflicts: [] });
    expect(mockAddFact).not.toHaveBeenCalled();
  });

  it('returns success with factsSaved=0 when extracted_user_information is missing', async () => {
    const result = await handleSaveExtractedFacts({});
    expect(result).toEqual({ success: true, factsSaved: 0, savedFacts: [], conflicts: [] });
  });

  it('saves a new fact and increments factsSaved', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Lives in Amsterdam' } as never);

    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['Lives in Amsterdam'],
    });

    expect(mockAddFact).toHaveBeenCalledWith('Lives in Amsterdam', undefined, undefined);
    expect(result).toMatchObject({ success: true, factsSaved: 1 });
  });

  it('saves a fact object with questionnaire metadata', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Senior ML engineer' } as never);

    await handleSaveExtractedFacts({
      extracted_user_information: [
        {
          statement: 'Senior ML engineer',
          questionnaire_level: 1,
          questionnaire_level_category: 'Core',
          questionnaire_attribute: 'profession: job role and industry',
        },
      ],
    });

    expect(mockAddFact).toHaveBeenCalledWith(
      'Senior ML engineer',
      undefined,
      expect.objectContaining({
        level: 1,
        levelCategory: 'Core',
        attribute: 'profession: job role and industry',
      }),
    );
  });

  it('rejects facts exceeding MAX_FACT_LENGTH', async () => {
    const longFact = 'a'.repeat(MAX_FACT_LENGTH + 1);
    const result = await handleSaveExtractedFacts({
      extracted_user_information: [longFact],
    });
    expect(mockAddFact).not.toHaveBeenCalled();
    expect(result).toMatchObject({ factsSaved: 0 });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rejects empty / whitespace-only facts', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['', '   '],
    });
    expect(mockAddFact).not.toHaveBeenCalled();
    expect(result).toMatchObject({ factsSaved: 0 });
  });

  it('rejects meta-conversational facts (User is setting up profile)', async () => {
    await handleSaveExtractedFacts({
      extracted_user_information: ['User is setting up persona'],
    });
    expect(mockAddFact).not.toHaveBeenCalled();
  });

  it('rejects facts matching "user wants to update profile" pattern', async () => {
    await handleSaveExtractedFacts({
      extracted_user_information: ['updating profile preferences'],
    });
    expect(mockAddFact).not.toHaveBeenCalled();
  });

  it('deduplicates against existing facts (case/space insensitive)', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'existing', statement: 'Lives in Amsterdam' } as never,
    ]);

    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['lives in amsterdam'], // duplicate (case-insensitive)
    });

    expect(mockAddFact).not.toHaveBeenCalled();
    expect(result).toMatchObject({ factsSaved: 0 });
  });

  it('saves multiple non-duplicate facts', async () => {
    mockAddFact
      .mockResolvedValueOnce({ id: 'f1', statement: 'fact 1' } as never)
      .mockResolvedValueOnce({ id: 'f2', statement: 'fact 2' } as never);

    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['fact 1', 'fact 2'],
    });

    expect(mockAddFact).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ factsSaved: 2 });
  });

  it('returns savedFacts enrichment with {id, statement} for each saved fact', async () => {
    mockAddFact
      .mockResolvedValueOnce({ id: 'f1', statement: 'fact 1' } as never)
      .mockResolvedValueOnce({ id: 'f2', statement: 'fact 2' } as never);

    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['fact 1', 'fact 2'],
    });

    expect(result).toMatchObject({
      success: true,
      factsSaved: 2,
      savedFacts: [
        { id: 'f1', statement: 'fact 1' },
        { id: 'f2', statement: 'fact 2' },
      ],
    });
  });

  it('returns an empty savedFacts array when nothing is saved', async () => {
    const result = await handleSaveExtractedFacts({ extracted_user_information: [] });
    expect(result).toMatchObject({ savedFacts: [] });
  });

  it('calls notifyFactMutation after saving facts', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'new fact' } as never);

    await handleSaveExtractedFacts({ extracted_user_information: ['new fact'] });

    expect(mockNotifyFactMutation).toHaveBeenCalled();
  });

  it('calls cloudBatchComplete for topic generation in cloud mode', async () => {
    (useMeraProtocolStore.getState as jest.Mock).mockReturnValue({ processingMode: 'CLOUD' });
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'new fact' } as never);
    mockCloudBatchComplete.mockResolvedValueOnce([]);

    await handleSaveExtractedFacts({ extracted_user_information: ['new fact'] });

    // cloudBatchComplete is called asynchronously via batchGenerateTopics.catch
    // Give the microtask queue a chance to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockCloudBatchComplete).toHaveBeenCalled();
  });

  it('enqueues a topic_gen job in on-device mode', async () => {
    (useMeraProtocolStore.getState as jest.Mock).mockReturnValue({ processingMode: 'OnDevice' });
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'AI news interest' } as never);

    await handleSaveExtractedFacts({ extracted_user_information: ['AI news interest'] });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockHasPendingJob).toHaveBeenCalledWith('topic_gen', 'factId', 'f1');
  });

  it('does not enqueue topic_gen job when one already exists', async () => {
    (useMeraProtocolStore.getState as jest.Mock).mockReturnValue({ processingMode: 'OnDevice' });
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'a new fact' } as never);
    mockHasPendingJob.mockResolvedValueOnce(true); // already pending

    await handleSaveExtractedFacts({ extracted_user_information: ['a new fact'] });
    await new Promise((r) => setTimeout(r, 0));

    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('Wave 11: returns an empty conflicts array when nothing conflicts', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Likes cycling' } as never);
    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['Likes cycling'],
    });
    expect(result).toMatchObject({ conflicts: [] });
  });

  it('Wave 11: surfaces a save-time conflict against a same-subject existing fact', async () => {
    // Pre-existing residence fact; the new one is a same-key correction.
    mockGetFacts.mockResolvedValueOnce([
      { id: 'e1', statement: 'Lives in Paris, France', questionnaireAttribute: 'location: residence' } as never,
    ]);
    mockAddFact.mockResolvedValueOnce({ id: 'n1', statement: 'Lives in Berlin, Germany' } as never);

    const result = await handleSaveExtractedFacts({
      extracted_user_information: [
        { statement: 'Lives in Berlin, Germany', questionnaire_attribute: 'location: city' },
      ],
    });

    expect(result.conflicts).toMatchObject([
      { newFactId: 'n1', existingFactId: 'e1', kind: 'attribute' },
    ]);
  });

  it('handles a mix of new and duplicate facts correctly', async () => {
    mockGetFacts.mockResolvedValueOnce([{ id: 'old', statement: 'Existing fact' } as never]);
    mockAddFact.mockResolvedValueOnce({ id: 'new', statement: 'New fact' } as never);

    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['Existing fact', 'New fact'],
    });

    expect(mockAddFact).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ factsSaved: 1 });
  });
});

// ============================================================
// handleUpdateUserConfig
// ============================================================

describe('handleUpdateUserConfig', () => {
  it('returns message when language_codes is missing', async () => {
    const result = await handleUpdateUserConfig({});
    expect(result).toMatchObject({ success: true, message: expect.stringContaining('No config') });
    expect(mockUpdateUserConfig).not.toHaveBeenCalled();
  });

  it('returns message when language_codes is not an array', async () => {
    const result = await handleUpdateUserConfig({ language_codes: 'en' });
    expect(result).toMatchObject({ success: true, message: expect.stringContaining('No config') });
  });

  it('calls AccountService.updateUserConfig with the language codes', async () => {
    const result = await handleUpdateUserConfig({ language_codes: ['en', 'nl'] });
    expect(mockUpdateUserConfig).toHaveBeenCalledWith('user-123', { language_codes: ['en', 'nl'] });
    expect(result).toMatchObject({ success: true, language_codes: ['en', 'nl'] });
  });

  it('skips server update when userId is null', async () => {
    (useUserStore.getState as jest.Mock).mockReturnValue({ userId: null });
    mockGetSetting.mockResolvedValueOnce(null); // cached_user_id also null

    await handleUpdateUserConfig({ language_codes: ['fr'] });

    expect(mockUpdateUserConfig).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('falls back to cached_user_id from DB when store userId is null', async () => {
    (useUserStore.getState as jest.Mock).mockReturnValue({ userId: null });
    mockGetSetting.mockResolvedValueOnce('cached-user-789');

    await handleUpdateUserConfig({ language_codes: ['de'] });

    expect(mockUpdateUserConfig).toHaveBeenCalledWith('cached-user-789', { language_codes: ['de'] });
  });

  it('does not reject when AccountService.updateUserConfig fails (fire-and-forget)', async () => {
    mockUpdateUserConfig.mockRejectedValueOnce(new Error('server error'));

    // Should not throw
    const result = await handleUpdateUserConfig({ language_codes: ['es'] });
    expect(result).toMatchObject({ success: true });
    // Give microtask queue a chance to catch the error
    await new Promise((r) => setTimeout(r, 0));
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ============================================================
// handleDeleteUserFacts
// ============================================================

describe('handleDeleteUserFacts', () => {
  it('returns error when fact_ids is missing', async () => {
    const result = await handleDeleteUserFacts({});
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('returns error when fact_ids is empty array', async () => {
    const result = await handleDeleteUserFacts({ fact_ids: [] });
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('returns error when fact_ids is not an array', async () => {
    const result = await handleDeleteUserFacts({ fact_ids: 'not-an-array' });
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('deletes a fact by questionnaire attribute key', async () => {
    mockGetFacts.mockResolvedValueOnce([
      {
        id: 'fact-uuid',
        statement: 'Works as an engineer',
        questionnaireAttribute: 'profession: job role and industry',
      } as never,
    ]);

    const result = await handleDeleteUserFacts({
      fact_ids: ['profession: job role and industry'],
    });

    expect(mockDeleteFact).toHaveBeenCalledWith('fact-uuid');
    expect(result).toMatchObject({ success: true, deletedCount: 1 });
  });

  it('deletes a fact by exact UUID', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'fact-uuid', statement: 'Lives in Amsterdam' } as never,
    ]);

    const result = await handleDeleteUserFacts({ fact_ids: ['fact-uuid'] });

    expect(mockDeleteFact).toHaveBeenCalledWith('fact-uuid');
    expect(result).toMatchObject({ success: true, deletedCount: 1 });
  });

  it('deletes a fact by matching statement text', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 'Lives in Amsterdam' } as never,
    ]);

    const result = await handleDeleteUserFacts({ fact_ids: ['lives in amsterdam'] });

    expect(mockDeleteFact).toHaveBeenCalledWith('f1');
    expect(result).toMatchObject({ success: true, deletedCount: 1 });
  });

  it('strips [brackets] from fact_id before matching', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 'Works in AI' } as never,
    ]);

    const result = await handleDeleteUserFacts({ fact_ids: ['[Works in AI]'] });

    expect(mockDeleteFact).toHaveBeenCalledWith('f1');
    expect(result).toMatchObject({ success: true, deletedCount: 1 });
  });

  it('returns deletedCount=0 when no matching facts found', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 'Lives in Amsterdam' } as never,
    ]);

    const result = await handleDeleteUserFacts({ fact_ids: ['nonexistent-fact'] });

    expect(mockDeleteFact).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, deletedCount: 0 });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('deduplicates fact_ids pointing to the same fact', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 'Works in AI' } as never,
    ]);

    const result = await handleDeleteUserFacts({ fact_ids: ['Works in AI', 'Works in AI'] });

    expect(mockDeleteFact).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, deletedCount: 1 });
  });

  it('calls notifyFactMutation after deleting', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 'Lives in Amsterdam' } as never,
    ]);

    await handleDeleteUserFacts({ fact_ids: ['f1'] });

    expect(mockNotifyFactMutation).toHaveBeenCalled();
  });

  it('deletes multiple facts in one call', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 'Fact one' } as never,
      { id: 'f2', statement: 'Fact two' } as never,
    ]);

    const result = await handleDeleteUserFacts({ fact_ids: ['f1', 'f2'] });

    expect(mockDeleteFact).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ success: true, deletedCount: 2 });
  });

  it('returns deletedStatements for the facts actually deleted', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 'Fact one' } as never,
      { id: 'f2', statement: 'Fact two' } as never,
    ]);

    const result = await handleDeleteUserFacts({ fact_ids: ['f1', 'f2'] });

    expect(result).toMatchObject({
      success: true,
      deletedCount: 2,
      deletedStatements: ['Fact one', 'Fact two'],
    });
  });

  it('returns an empty deletedStatements array when no facts match', async () => {
    mockGetFacts.mockResolvedValueOnce([
      { id: 'f1', statement: 'Lives in Amsterdam' } as never,
    ]);

    const result = await handleDeleteUserFacts({ fact_ids: ['nonexistent'] });

    expect(result).toMatchObject({ deletedCount: 0, deletedStatements: [] });
  });
});

// ============================================================
// handleAdvanceQuestionnaireLevel
// ============================================================

describe('handleAdvanceQuestionnaireLevel', () => {
  it('returns message when already at TOTAL_LEVELS (10)', async () => {
    mockGetQuestionnaireLevel.mockResolvedValueOnce(10);

    const result = await handleAdvanceQuestionnaireLevel();

    expect(result).toMatchObject({
      success: true,
      level: 10,
      message: expect.stringContaining('final level'),
    });
    expect(mockSetQuestionnaireLevel).not.toHaveBeenCalled();
  });

  it('prevents advancing when no facts gathered for current level', async () => {
    mockGetQuestionnaireLevel.mockResolvedValueOnce(1);
    mockGetCoveredAttributeKeys.mockResolvedValueOnce(new Set<string>()); // nothing covered

    const result = await handleAdvanceQuestionnaireLevel();

    expect(result).toMatchObject({
      success: false,
      level: 1,
      message: expect.stringContaining('Cannot advance'),
    });
    expect(mockSetQuestionnaireLevel).not.toHaveBeenCalled();
  });

  it('advances to next level when at least one key is covered', async () => {
    mockGetQuestionnaireLevel.mockResolvedValueOnce(1);
    mockGetCoveredAttributeKeys.mockResolvedValueOnce(new Set(['location']));

    const result = await handleAdvanceQuestionnaireLevel();

    expect(mockSetQuestionnaireLevel).toHaveBeenCalledWith(2);
    expect(result).toMatchObject({
      success: true,
      previousLevel: 1,
      level: 2,
      totalLevels: 10,
    });
  });

  it('includes totalLevels in successful response', async () => {
    mockGetQuestionnaireLevel.mockResolvedValueOnce(5);
    mockGetCoveredAttributeKeys.mockResolvedValueOnce(new Set(['location']));

    const result = await handleAdvanceQuestionnaireLevel();

    expect(result).toMatchObject({ totalLevels: 10 });
  });

  it('handles advancing from level 9 to 10 (second-to-last)', async () => {
    mockGetQuestionnaireLevel.mockResolvedValueOnce(9);
    // level 9 attributes include 'ventures' — the mock returns ['location', ...] by default
    // so override it to include a key that matches the covered set
    const { getAttributeKeysForLevel } = require('../../mera-protocol/questionnaire-data');
    (getAttributeKeysForLevel as jest.Mock).mockReturnValueOnce(['ventures', 'thought_leaders_following']);
    mockGetCoveredAttributeKeys.mockResolvedValueOnce(new Set(['ventures']));

    const result = await handleAdvanceQuestionnaireLevel();

    expect(result).toMatchObject({ success: true, level: 10 });
  });
});

// ============================================================
// handleIssueWarning
// ============================================================

describe('handleIssueWarning', () => {
  it('issues a server-authoritative warning and returns warning info when not blocked', async () => {
    mockIssueLlmWarning.mockResolvedValueOnce(personaWith({ llmWarningCount: 1, blockedByLlm: false }));

    const result = await handleIssueWarning({ reason: 'Off-topic message' });

    expect(mockIssueLlmWarning).toHaveBeenCalledWith('user-123', 'Off-topic message');
    expect(result).toMatchObject({
      blocked: false,
      warningCount: 1,
      message: expect.stringContaining('1/3'),
    });
  });

  it('uses default reason when none provided', async () => {
    mockIssueLlmWarning.mockResolvedValueOnce(personaWith({ llmWarningCount: 2 }));

    const result = await handleIssueWarning({});

    expect(mockIssueLlmWarning).toHaveBeenCalledWith('user-123', 'No reason provided');
    expect(result).toMatchObject({ blocked: false, warningCount: 2 });
  });

  it('reports blocked when the server blocks the user', async () => {
    mockIssueLlmWarning.mockResolvedValueOnce(
      personaWith({ llmWarningCount: 3, blockedByLlm: true, blockedByLlmReason: 'Repeated abuse' }),
    );

    const result = await handleIssueWarning({ reason: 'Third violation' });

    expect(result).toMatchObject({
      blocked: true,
      warningCount: 3,
      message: 'Repeated abuse',
    });
  });

  it('syncs the returned persona into the user store', async () => {
    const persona = personaWith({ llmWarningCount: 1 });
    mockIssueLlmWarning.mockResolvedValueOnce(persona);

    await handleIssueWarning({ reason: 'reason' });

    expect(mockSetUserPersona).toHaveBeenCalledWith(persona);
  });

  it('fails OPEN (blocked:false) when the mutation throws', async () => {
    mockIssueLlmWarning.mockRejectedValueOnce(new Error('network down'));

    const result = await handleIssueWarning({ reason: 'reason' });

    expect(result).toMatchObject({ blocked: false, warningCount: 0 });
  });

  it('fails OPEN when no userId is available', async () => {
    (useUserStore.getState as jest.Mock).mockReturnValueOnce({ userId: null, setUserPersona: mockSetUserPersona });
    mockGetSetting.mockResolvedValueOnce(null); // cached_user_id lookup → null

    const result = await handleIssueWarning({ reason: 'reason' });

    expect(mockIssueLlmWarning).not.toHaveBeenCalled();
    expect(result).toMatchObject({ blocked: false, warningCount: 0 });
  });

  it('logs the warning', async () => {
    mockIssueLlmWarning.mockResolvedValueOnce(personaWith({ llmWarningCount: 1 }));

    await handleIssueWarning({ reason: 'test reason' });

    expect(logger.warn).toHaveBeenCalled();
  });
});

// ============================================================
// batchGenerateTopics (internal, exercised via handleSaveExtractedFacts cloud path)
// ============================================================

describe('batchGenerateTopics (via handleSaveExtractedFacts cloud path)', () => {
  const { buildCloudBatchCallsForFact, mergeRealOutputsForFact } =
    require('../../mera-protocol/topic-generation-service') as {
      buildCloudBatchCallsForFact: jest.Mock;
      mergeRealOutputsForFact: jest.Mock;
    };

  beforeEach(() => {
    (useMeraProtocolStore.getState as jest.Mock).mockReturnValue({ processingMode: 'CLOUD' });
  });

  /** Helper: save a fact and wait for all microtasks (the fire-and-forget chain). */
  async function saveAndFlush(statement: string): Promise<void> {
    await handleSaveExtractedFacts({ extracted_user_information: [statement] });
    // Flush the .catch(() => ...) chain from batchGenerateTopics
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  it('calls updateFact with topics when cloudBatchComplete succeeds', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Works in AI' } as never);
    buildCloudBatchCallsForFact.mockReturnValueOnce([
      { id: 'f1:factOnly', system: 's', prompt: 'p', temperature: 0.3, maxTokens: 400 },
    ]);
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'f1:factOnly', output: '["AI news", "ML policy"]' },
    ]);
    mergeRealOutputsForFact.mockReturnValueOnce(['AI news', 'ML policy']);

    await saveAndFlush('Works in AI');

    expect(mockUpdateFact).toHaveBeenCalledWith('f1', { metadata: { topics: ['AI news', 'ML policy'] } });
  });

  it('Wave 11: mints topic ROWS (syncLlmTopicsForFact) alongside the metadata dual-write', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Works in AI' } as never);
    buildCloudBatchCallsForFact.mockReturnValueOnce([
      { id: 'f1:factOnly', system: 's', prompt: 'p', temperature: 0.3, maxTokens: 400 },
    ]);
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'f1:factOnly', output: '["AI news", "ML policy"]' },
    ]);
    mergeRealOutputsForFact.mockReturnValueOnce(['AI news', 'ML policy']);

    await saveAndFlush('Works in AI');

    // Legacy dual-write preserved AND rows minted from the same texts.
    expect(mockUpdateFact).toHaveBeenCalledWith('f1', { metadata: { topics: ['AI news', 'ML policy'] } });
    expect(mockSyncLlmTopicsForFact).toHaveBeenCalledWith('f1', ['AI news', 'ML policy']);
  });

  it('Wave 11: does NOT mint rows when generation yields only a topicGenError', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Works in AI' } as never);
    buildCloudBatchCallsForFact.mockReturnValueOnce([
      { id: 'f1:factOnly', system: 's', prompt: 'p', temperature: 0.3, maxTokens: 400 },
    ]);
    mockCloudBatchComplete.mockRejectedValueOnce(new Error('network error'));

    await saveAndFlush('Works in AI');

    expect(mockSyncLlmTopicsForFact).not.toHaveBeenCalled();
  });

  it('calls updateFact with topicGenError when cloudBatchComplete throws', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Works in AI' } as never);
    buildCloudBatchCallsForFact.mockReturnValueOnce([
      { id: 'f1:factOnly', system: 's', prompt: 'p', temperature: 0.3, maxTokens: 400 },
    ]);
    mockCloudBatchComplete.mockRejectedValueOnce(new Error('network error'));

    await saveAndFlush('Works in AI');

    expect(mockUpdateFact).toHaveBeenCalledWith('f1', { metadata: { topicGenError: ['network error'] } });
  });

  it('calls updateFact with topicGenError when result has no topics', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Works in AI' } as never);
    buildCloudBatchCallsForFact.mockReturnValueOnce([
      { id: 'f1:factOnly', system: 's', prompt: 'p', temperature: 0.3, maxTokens: 400 },
    ]);
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'f1:factOnly', output: '[]' },
    ]);
    mergeRealOutputsForFact.mockReturnValueOnce([]); // no topics parsed

    await saveAndFlush('Works in AI');

    expect(mockUpdateFact).toHaveBeenCalledWith('f1', expect.objectContaining({
      metadata: expect.objectContaining({ topicGenError: expect.any(Array) }),
    }));
  });

  it('calls updateFact with topicGenError when no result returned for a fact', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Works in AI' } as never);
    buildCloudBatchCallsForFact.mockReturnValueOnce([
      { id: 'f1:factOnly', system: 's', prompt: 'p', temperature: 0.3, maxTokens: 400 },
    ]);
    // Return a result for a different fact id
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'other:factOnly', output: '["some topic"]' },
    ]);

    await saveAndFlush('Works in AI');

    expect(mockUpdateFact).toHaveBeenCalledWith('f1', { metadata: { topicGenError: ['No topic-gen result returned'] } });
  });

  it('logs warning for a result with no colon separator in id', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Works in AI' } as never);
    buildCloudBatchCallsForFact.mockReturnValueOnce([
      { id: 'f1:factOnly', system: 's', prompt: 'p', temperature: 0.3, maxTokens: 400 },
    ]);
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'nocolon', output: '["topic"]' }, // no ':' separator
    ]);

    await saveAndFlush('Works in AI');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unexpected result id'),
      expect.any(Object),
    );
  });

  it('logs warning when a half result has an error (but continues)', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Works in AI' } as never);
    buildCloudBatchCallsForFact.mockReturnValueOnce([
      { id: 'f1:factOnly', system: 's', prompt: 'p', temperature: 0.3, maxTokens: 400 },
    ]);
    mockCloudBatchComplete.mockResolvedValueOnce([
      { id: 'f1:factOnly', output: '', error: 'half failed' },
    ]);
    mergeRealOutputsForFact.mockReturnValueOnce([]);

    await saveAndFlush('Works in AI');

    expect(logger.warn).toHaveBeenCalledWith('[topic-gen-batch] half failed', expect.any(Object));
  });

  it('logs warn via .catch when batchGenerateTopics throws at the top level', async () => {
    // Cause batchGenerateTopics to throw synchronously by making getFacts throw.
    // The second call to getFacts (inside batchGenerateTopics) throws, which rejects
    // the promise, triggering the .catch in handleSaveExtractedFacts.
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'new fact' } as never);
    mockGetFacts
      .mockResolvedValueOnce([]) // first call: dedup check
      .mockRejectedValueOnce(new Error('db error')); // second call: inside batchGenerateTopics

    await saveAndFlush('new fact');

    expect(logger.warn).toHaveBeenCalledWith(
      '[saveExtractedFacts] Batch topic gen failed',
      expect.any(Object),
    );
  });

  it('logs warn when hasPendingJob rejects in on-device mode', async () => {
    (useMeraProtocolStore.getState as jest.Mock).mockReturnValue({ processingMode: 'OnDevice' });
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'new fact' } as never);
    mockHasPendingJob.mockRejectedValueOnce(new Error('db error'));

    await saveAndFlush('new fact');

    expect(logger.warn).toHaveBeenCalledWith('Failed to enqueue topic gen', expect.any(Object));
  });

  it('calls inferenceQueue.notify after enqueuing a job', async () => {
    (useMeraProtocolStore.getState as jest.Mock).mockReturnValue({ processingMode: 'OnDevice' });
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'new fact' } as never);
    mockHasPendingJob.mockResolvedValueOnce(false);
    mockEnqueueJob.mockResolvedValueOnce({ id: 'job-1' } as never);

    await saveAndFlush('new fact');

    expect(inferenceQueue.notify).toHaveBeenCalled();
  });

  it('uses user location when available in allFacts', async () => {
    const locationFact = {
      id: 'loc-id',
      statement: 'Lives in Amsterdam',
      questionnaireAttribute: 'location: neighborhood/area, city, and country (preserve specifics)',
    };
    const { buildAttributeTextToIdMap } = require('../../mera-protocol/questionnaire-data');
    (buildAttributeTextToIdMap as jest.Mock).mockReturnValueOnce(
      new Map([['location: neighborhood/area, city, and country (preserve specifics)', 'q1_location']]),
    );
    // allFacts returns the location fact (for the batchGenerateTopics call)
    mockGetFacts
      .mockResolvedValueOnce([]) // first call: for dedup check
      .mockResolvedValueOnce([locationFact as never]); // second call: inside batchGenerateTopics

    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Works in AI' } as never);
    mockCloudBatchComplete.mockResolvedValueOnce([]);

    await saveAndFlush('Works in AI');

    // buildCloudBatchCallsForFact should have been called with userLocation
    expect(buildCloudBatchCallsForFact).toHaveBeenCalledWith(
      expect.objectContaining({ userLocation: 'Lives in Amsterdam' }),
      'f1',
    );
  });
});
