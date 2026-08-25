// Tests for chat-tools/tool-handlers.ts
// Mocks every I/O dependency: DB services, stores, LLM, AccountService, InferenceQueue.

jest.mock('../../database/services/fact-service', () => ({
  addFact: jest.fn(),
  deleteFact: jest.fn(),
  getFacts: jest.fn(() => Promise.resolve([])),
  updateFact: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../database/services/setting-service', () => ({
  getSetting: jest.fn(() => Promise.resolve(null)),
  setSetting: jest.fn(() => Promise.resolve()),
}));
// Must be mocked, not merely stubbed: the real module reaches location-service
// → lib/database → SQLiteAdapter, which cannot initialize under Jest.
jest.mock('../../database/services/geo-derivation-service', () => ({
  runGeoDerivationSweep: jest.fn(() => Promise.resolve({ ran: true, added: 0, reweighted: 0 })),
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
  handleExplainMera,
  handleIssueWarning,
  isTopicGenerationInFlight,
  retryTopicGeneration,
  MAX_FACT_LENGTH,
} from '../tool-handlers';
import { commitFactChoices } from '../fact-commit';
import {
  addFact,
  deleteFact,
  getFacts,
  updateFact,
} from '../../database/services/fact-service';
import { getSetting, setSetting } from '../../database/services/setting-service';
import { runGeoDerivationSweep } from '../../database/services/geo-derivation-service';
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

describe('handleSaveExtractedFacts — OFFERS, never writes', () => {
  // The whole point of this handler after propose-then-save: it must not touch
  // the database. Every assertion that it DID write moved to fact-commit.test.ts.
  it('returns an empty staged result when no facts provided', async () => {
    const result = await handleSaveExtractedFacts({ extracted_user_information: [] });
    expect(result).toEqual({
      success: true,
      staged: true,
      factsSaved: 0,
      savedFacts: [],
      conflicts: [],
      pendingFacts: [],
    });
    expect(mockAddFact).not.toHaveBeenCalled();
  });

  it('returns an empty staged result when extracted_user_information is missing', async () => {
    const result = await handleSaveExtractedFacts({});
    expect(result).toMatchObject({ success: true, staged: true, factsSaved: 0, pendingFacts: [] });
  });

  it('WRITES NOTHING and generates no topics for a perfectly good fact', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['Lives in Amsterdam'],
    });

    expect(mockAddFact).not.toHaveBeenCalled();
    expect(runGeoDerivationSweep).not.toHaveBeenCalled();
    expect(result).toMatchObject({ staged: true, factsSaved: 0, savedFacts: [] });
    expect(result.pendingFacts).toEqual([
      { index: 0, options: ['Lives in Amsterdam'], questionnaireAttribute: null },
    ]);
  });

  // `factsSaved: 0` is load-bearing: deriveCard falls back to reading the tool
  // INPUT when `savedFacts` is absent, so a staged turn without an explicit zero
  // would render "Saved to your persona" for facts that were never saved.
  it('always reports factsSaved: 0 while staged', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['A', 'Lives in Amsterdam'],
    });
    expect(result.factsSaved).toBe(0);
    expect(result.savedFacts).toEqual([]);
  });

  it('carries the questionnaire attribute through to the card', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: [
        {
          statement: 'Senior ML engineer',
          questionnaire_attribute: 'profession: job role and industry',
        },
      ],
    });

    // It must reach addFact eventually — resolveUserLocationFact keys on it.
    expect(result.pendingFacts).toEqual([
      {
        index: 0,
        options: ['Senior ML engineer'],
        questionnaireAttribute: 'profession: job role and industry',
      },
    ]);
  });

  it('offers alternatives as extra options on the SAME group', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: [
        {
          statement: 'Follows Sporting CP, the Portuguese football club',
          alternatives: ['Interested in football clubs generally'],
        },
      ],
    });

    expect(result.pendingFacts).toEqual([
      {
        index: 0,
        options: [
          'Follows Sporting CP, the Portuguese football club',
          'Interested in football clubs generally',
        ],
        questionnaireAttribute: null,
      },
    ]);
  });

  it('gives each distinct fact its own group', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['Lives in Amsterdam', 'Works in AI'],
    });
    const groups = result.pendingFacts as { options: string[] }[];
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.options)).toEqual([['Lives in Amsterdam'], ['Works in AI']]);
  });

  // The accept/reject rules still run BEFORE the card, so a reading that could
  // never be saved is not offered and then refused after the tap.
  it('rejects facts exceeding MAX_FACT_LENGTH', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['x'.repeat(201)],
    });
    expect(result.pendingFacts).toEqual([]);
  });

  it('rejects empty / whitespace-only facts', async () => {
    const result = await handleSaveExtractedFacts({ extracted_user_information: ['   ', ''] });
    expect(result.pendingFacts).toEqual([]);
  });

  it('rejects meta-conversational facts', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['User is setting up profile'],
    });
    expect(result.pendingFacts).toEqual([]);
  });

  it('deduplicates against existing facts (case/space insensitive)', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'e1', statement: 'Lives  in AMSTERDAM', questionnaireAttribute: null },
    ] as never);

    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['lives in amsterdam'],
    });

    expect(result.pendingFacts).toEqual([]);
  });

  it('drops a duplicate READING but keeps the rest of its group', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'e1', statement: 'Interested in football clubs generally', questionnaireAttribute: null },
    ] as never);

    const result = await handleSaveExtractedFacts({
      extracted_user_information: [
        {
          statement: 'Follows Sporting CP',
          alternatives: ['Interested in football clubs generally'],
        },
      ],
    });

    expect(result.pendingFacts).toEqual([
      { index: 0, options: ['Follows Sporting CP'], questionnaireAttribute: null },
    ]);
  });
});

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

describe('batchGenerateTopics (via the fact-commit cloud path)', () => {
  const { buildCloudBatchCallsForFact, mergeRealOutputsForFact } =
    require('../../mera-protocol/topic-generation-service') as {
      buildCloudBatchCallsForFact: jest.Mock;
      mergeRealOutputsForFact: jest.Mock;
    };

  beforeEach(() => {
    (useMeraProtocolStore.getState as jest.Mock).mockReturnValue({ processingMode: 'CLOUD' });
  });

  /** Helper: COMMIT a fact and wait for all microtasks (the fire-and-forget chain).
   *  Topic generation moved here when saving became propose-then-commit: the
   *  tool call only offers readings now, so driving this through the handler
   *  would exercise nothing. */
  async function saveAndFlush(statement: string): Promise<void> {
    await commitFactChoices([{ statement }]);
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

// ============================================================
// retryTopicGeneration / in-flight guard (NEAR-stall plan B)
// ============================================================

describe('retryTopicGeneration', () => {
  const { buildCloudBatchCallsForFact } =
    require('../../mera-protocol/topic-generation-service') as {
      buildCloudBatchCallsForFact: jest.Mock;
    };

  beforeEach(() => {
    (useMeraProtocolStore.getState as jest.Mock).mockReturnValue({ processingMode: 'CLOUD' });
    buildCloudBatchCallsForFact.mockReturnValue([
      { id: 'f1:factOnly', system: 's', prompt: 'p', temperature: 0.3, maxTokens: 400 },
    ]);
  });

  it('clears the stored topicGenError before re-running generation', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'Works in AI', metadata: { topicGenError: ['boom'] } } as never,
    ]);

    await retryTopicGeneration('f1', 'Works in AI');

    expect(mockUpdateFact).toHaveBeenCalledWith('f1', { metadata: {} });
    expect(mockCloudBatchComplete).toHaveBeenCalled();
  });

  it('preserves other metadata keys when clearing the error', async () => {
    mockGetFacts.mockResolvedValue([
      {
        id: 'f1',
        statement: 'Works in AI',
        metadata: { topicGenError: ['boom'], topics: ['old'] },
      } as never,
    ]);

    await retryTopicGeneration('f1', 'Works in AI');

    expect(mockUpdateFact).toHaveBeenCalledWith('f1', { metadata: { topics: ['old'] } });
  });

  it('reuses the batch path — exactly one cloudBatchComplete call per retry', async () => {
    mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Works in AI' } as never]);

    await retryTopicGeneration('f1', 'Works in AI');

    expect(mockCloudBatchComplete).toHaveBeenCalledTimes(1);
  });

  it('drops a concurrent retry for the same factId (no double batch call)', async () => {
    mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Works in AI' } as never]);
    let release: (v: unknown) => void = () => { };
    mockCloudBatchComplete.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve as (v: unknown) => void; }) as never,
    );

    const first = retryTopicGeneration('f1', 'Works in AI');
    // Let the first claim the fact, then fire a second retry while it runs.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const second = retryTopicGeneration('f1', 'Works in AI');
    await second;

    expect(mockCloudBatchComplete).toHaveBeenCalledTimes(1);
    release([]);
    await first;
    expect(isTopicGenerationInFlight('f1')).toBe(false);
  });

  it('reports in-flight while running and releases afterwards', async () => {
    mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Works in AI' } as never]);
    let release: (v: unknown) => void = () => { };
    mockCloudBatchComplete.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve as (v: unknown) => void; }) as never,
    );

    const promise = retryTopicGeneration('f1', 'Works in AI');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(isTopicGenerationInFlight('f1')).toBe(true);

    release([]);
    await promise;
    expect(isTopicGenerationInFlight('f1')).toBe(false);
  });

  it('a retry whose generation throws OUTSIDE the harness still records topicGenError', async () => {
    // buildCloudBatchCallsForFact throwing escapes the harness try/catch — the
    // card would otherwise spin forever with no error and no topics.
    mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Works in AI' } as never]);
    buildCloudBatchCallsForFact.mockImplementationOnce(() => {
      throw new Error('call building blew up');
    });

    await retryTopicGeneration('f1', 'Works in AI');

    expect(mockUpdateFact).toHaveBeenCalledWith('f1', {
      metadata: { topicGenError: ['call building blew up'] },
    });
    expect(mockNotifyFactMutation).toHaveBeenCalled();
    expect(isTopicGenerationInFlight('f1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleExplainMera — the CLOUD knowledge tool. Pure read of a frozen reference
// document: no DB, no network, no side effects. The point of it is that Mera
// answers a privacy question from SOURCED TEXT rather than from model memory,
// so an unknown id must come back as a retryable error and never as a partial
// answer the model would then fill in itself.
// ---------------------------------------------------------------------------

describe('handleExplainMera', () => {
  it('returns the requested sections, in order, with their text', async () => {
    const result = await handleExplainMera({
      topics: ['privacy_what_leaves_device', 'known_gaps'],
    });

    const sections = result.sections as { topic: string; text: string }[];
    expect(sections.map((s) => s.topic)).toEqual([
      'privacy_what_leaves_device',
      'known_gaps',
    ]);
    for (const s of sections) expect(s.text.length).toBeGreaterThan(200);
    expect(result.error).toBeUndefined();
  });

  it('returns availableTopics on an unknown id so the model can retry', async () => {
    const result = await handleExplainMera({ topics: ['how_do_you_make_money'] });

    expect(result.sections).toBeUndefined();
    expect(result.error).toContain('how_do_you_make_money');
    expect(result.availableTopics).toContain('what_is_mera');
    expect(result.availableTopics).toContain('known_gaps');
  });

  it('rejects rather than half-answers when ONE of several ids is unknown', async () => {
    const result = await handleExplainMera({ topics: ['what_is_mera', 'nope'] });
    expect(result.sections).toBeUndefined();
    expect(result.availableTopics).toBeDefined();
  });

  it('errors with availableTopics when topics is missing, empty, or not an array', async () => {
    for (const args of [{}, { topics: [] }, { topics: 'known_gaps' }]) {
      const result = await handleExplainMera(args);
      expect(result.sections).toBeUndefined();
      expect(result.availableTopics).toBeDefined();
    }
  });

  it('caps at 3 sections rather than erroring — an error would burn a round trip', async () => {
    const result = await handleExplainMera({
      topics: [
        'what_is_mera',
        'privacy_what_leaves_device',
        'privacy_what_we_store',
        'encryption_and_inference',
        'how_news_works',
      ],
    });

    const sections = result.sections as { topic: string }[];
    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.topic)).toEqual([
      'what_is_mera',
      'privacy_what_leaves_device',
      'privacy_what_we_store',
    ]);
  });

  it('de-duplicates a repeated id — these are the largest entries in the budget', async () => {
    const result = await handleExplainMera({ topics: ['known_gaps', 'known_gaps'] });
    expect(result.sections).toHaveLength(1);
  });

  it('touches no I/O at all', async () => {
    await handleExplainMera({ topics: ['what_is_mera'] });
    expect(mockGetFacts).not.toHaveBeenCalled();
    expect(mockAddFact).not.toHaveBeenCalled();
    expect(mockUpdateFact).not.toHaveBeenCalled();
  });
});
