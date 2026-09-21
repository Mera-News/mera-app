// topic-gen-handler.test.ts — unit tests for lib/inference/handlers/topic-gen-handler.ts

const mockGetFacts = jest.fn();
const mockUpdateFact = jest.fn();

jest.mock('../../database/services/fact-service', () => ({
  getFacts: (...args: unknown[]) => mockGetFacts(...args),
  updateFact: (...args: unknown[]) => mockUpdateFact(...args),
}));

const mockBuildAttributeTextToIdMap = jest.fn();

jest.mock('../../mera-protocol/questionnaire-data', () => ({
  buildAttributeTextToIdMap: (...args: unknown[]) => mockBuildAttributeTextToIdMap(...args),
}));

const mockGenerateTopicsForFact = jest.fn();

jest.mock('../../mera-protocol/topic-generation-service', () => ({
  generateTopicsForFact: (...args: unknown[]) => mockGenerateTopicsForFact(...args),
}));

const mockNotifyFactMutation = jest.fn();

jest.mock('../../stores/floating-chat-store', () => ({
  useFloatingChatStore: {
    getState: jest.fn(() => ({ notifyFactMutation: mockNotifyFactMutation })),
  },
}));

const mockSyncLlmTopicsForFact = jest.fn((..._args: unknown[]) => Promise.resolve([]));

const mockGetActive = jest.fn(async () => [] as { text: string }[]);
jest.mock('../../database/services/topic-service', () => ({
  syncLlmTopicsForFact: (...args: unknown[]) => mockSyncLlmTopicsForFact(...args),
  getActive: () => mockGetActive(),
}));

// These three reach lib/database/index, which constructs a real SQLiteAdapter
// at module scope and dies under jest with `Cannot read properties of
// undefined (reading 'initializeJSI')`. Mocking the SERVICE keeps the handler
// honest while keeping the adapter out of the import graph.
const mockGetDeclinedTopicTexts = jest.fn(async () => [] as string[]);
jest.mock('../../database/services/topic-decline-service', () => ({
  getDeclinedTopicTexts: () => mockGetDeclinedTopicTexts(),
}));

const mockCompleteTopicGeneration = jest.fn(async () => []);
const mockFailTopicGeneration = jest.fn(async () => undefined);
jest.mock('../../database/services/topic-generation-status-service', () => ({
  completeTopicGeneration: (...a: unknown[]) => mockCompleteTopicGeneration(...(a as [])),
  failTopicGeneration: (...a: unknown[]) => mockFailTopicGeneration(...(a as [])),
}));

const mockCloudComplete = jest.fn(async (_req: { systemPrompt: string; prompt: string }) => '[]');
jest.mock('../../llm/cloudComplete', () => ({
  cloudComplete: (req: { systemPrompt: string; prompt: string }) => mockCloudComplete(req),
}));
jest.mock('../../llm/constants', () => ({ SMALL_MODEL: 'test-small' }));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { handleTopicGenJob } from '../handlers/topic-gen-handler';
import type { TopicGenPayload } from '../handlers/topic-gen-handler';

const ATTR_MAP = new Map([
  ['location: neighborhood/area, city, and country', 'q1_location'],
  ['where you grew up', 'q2_origin'],
  ['neighborhood', 'q4_neighborhood'],
]);

describe('handleTopicGenJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildAttributeTextToIdMap.mockReturnValue(ATTR_MAP);
    mockUpdateFact.mockResolvedValue(undefined);
    mockGenerateTopicsForFact.mockResolvedValue(['topic A', 'topic B']);
  });

  it('returns generated topics and updates fact metadata', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'the target fact', questionnaireAttribute: null },
    ]);

    const payload: TopicGenPayload = {
      factId: 'f1',
      factStatement: 'the target fact',
      useCloud: false,
    };

    const result = await handleTopicGenJob(payload);

    expect(result.topics).toEqual(['topic A', 'topic B']);
    expect(mockUpdateFact).toHaveBeenCalledWith('f1', {
      metadata: { topics: ['topic A', 'topic B'] },
    });
    // Wave 11: mints topic ROWS alongside the legacy metadata dual-write.
    expect(mockSyncLlmTopicsForFact).toHaveBeenCalledWith('f1', ['topic A', 'topic B']);
    expect(mockNotifyFactMutation).toHaveBeenCalled();
  });

  it('does NOT mint topic rows when no topics were generated', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'the target fact', questionnaireAttribute: null },
    ]);
    mockGenerateTopicsForFact.mockResolvedValue([]);

    await handleTopicGenJob({ factId: 'f1', factStatement: 'the target fact' });

    expect(mockSyncLlmTopicsForFact).not.toHaveBeenCalled();
  });

  it('returns empty topics and skips updateFact when no topics generated', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'the target fact', questionnaireAttribute: null },
    ]);
    mockGenerateTopicsForFact.mockResolvedValue([]);

    const payload: TopicGenPayload = { factId: 'f1', factStatement: 'the target fact' };

    const result = await handleTopicGenJob(payload);

    expect(result.topics).toEqual([]);
    expect(mockUpdateFact).not.toHaveBeenCalled();
    expect(mockNotifyFactMutation).not.toHaveBeenCalled();
  });

  it('excludes the target fact itself from otherFacts', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'target', questionnaireAttribute: null },
      { id: 'f2', statement: 'other', questionnaireAttribute: null },
    ]);

    const payload: TopicGenPayload = { factId: 'f1', factStatement: 'target' };
    await handleTopicGenJob(payload);

    const callArgs = mockGenerateTopicsForFact.mock.calls[0][0];
    expect(callArgs.otherFacts).toEqual(['other']);
    expect(callArgs.otherFacts).not.toContain('target');
  });

  it('identifies userLocation from q1_location attribute', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'target fact', questionnaireAttribute: null },
      {
        id: 'f2',
        statement: 'I live in Berlin',
        questionnaireAttribute: 'location: neighborhood/area, city, and country',
      },
    ]);

    const payload: TopicGenPayload = { factId: 'f1', factStatement: 'target fact' };
    await handleTopicGenJob(payload);

    const callArgs = mockGenerateTopicsForFact.mock.calls[0][0];
    expect(callArgs.userLocation).toBe('I live in Berlin');
  });

  it('identifies userLocation from q4_neighborhood attribute', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'target', questionnaireAttribute: null },
      {
        id: 'f3',
        statement: 'I live in Prenzlauer Berg',
        questionnaireAttribute: 'neighborhood',
      },
    ]);

    const payload: TopicGenPayload = { factId: 'f1', factStatement: 'target' };
    await handleTopicGenJob(payload);

    const callArgs = mockGenerateTopicsForFact.mock.calls[0][0];
    expect(callArgs.userLocation).toBe('I live in Prenzlauer Berg');
  });

  it('passes null userLocation when no location fact exists', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'target', questionnaireAttribute: null },
      { id: 'f2', statement: 'I work in finance', questionnaireAttribute: null },
    ]);

    const payload: TopicGenPayload = { factId: 'f1', factStatement: 'target' };
    await handleTopicGenJob(payload);

    const callArgs = mockGenerateTopicsForFact.mock.calls[0][0];
    expect(callArgs.userLocation).toBeNull();
  });

  it('excludes the location fact from otherFacts', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'target', questionnaireAttribute: null },
      {
        id: 'f2',
        statement: 'I live in Berlin',
        questionnaireAttribute: 'location: neighborhood/area, city, and country',
      },
      { id: 'f3', statement: 'I work in tech', questionnaireAttribute: null },
    ]);

    const payload: TopicGenPayload = { factId: 'f1', factStatement: 'target' };
    await handleTopicGenJob(payload);

    const callArgs = mockGenerateTopicsForFact.mock.calls[0][0];
    // Location fact should not appear in otherFacts
    expect(callArgs.otherFacts).not.toContain('I live in Berlin');
    expect(callArgs.otherFacts).toContain('I work in tech');
  });

  it('does not use target fact as location even if it has a location attribute', async () => {
    mockGetFacts.mockResolvedValue([
      {
        id: 'f1',
        statement: 'I live in Berlin',
        questionnaireAttribute: 'location: neighborhood/area, city, and country',
      },
    ]);

    const payload: TopicGenPayload = {
      factId: 'f1',
      factStatement: 'I live in Berlin',
    };
    await handleTopicGenJob(payload);

    const callArgs = mockGenerateTopicsForFact.mock.calls[0][0];
    // Target fact is excluded from userLocation search (f.id === payload.factId check)
    expect(callArgs.userLocation).toBeNull();
  });

  it('passes useCloud=false by default', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'target', questionnaireAttribute: null },
    ]);

    const payload: TopicGenPayload = { factId: 'f1', factStatement: 'target' };
    await handleTopicGenJob(payload);

    const callArgs = mockGenerateTopicsForFact.mock.calls[0][0];
    expect(callArgs.useCloud).toBe(false);
  });

  it('passes useCloud=true when specified', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'target', questionnaireAttribute: null },
    ]);

    const payload: TopicGenPayload = {
      factId: 'f1',
      factStatement: 'target',
      useCloud: true,
    };
    await handleTopicGenJob(payload);

    const callArgs = mockGenerateTopicsForFact.mock.calls[0][0];
    expect(callArgs.useCloud).toBe(true);
  });

  it('passes factStatement to generateTopicsForFact', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'specific statement', questionnaireAttribute: null },
    ]);

    const payload: TopicGenPayload = {
      factId: 'f1',
      factStatement: 'specific statement',
    };
    await handleTopicGenJob(payload);

    const callArgs = mockGenerateTopicsForFact.mock.calls[0][0];
    expect(callArgs.factStatement).toBe('specific statement');
  });

  it('handles empty facts array gracefully', async () => {
    mockGetFacts.mockResolvedValue([]);

    const payload: TopicGenPayload = {
      factId: 'f99',
      factStatement: 'orphan fact',
    };
    await handleTopicGenJob(payload);

    const callArgs = mockGenerateTopicsForFact.mock.calls[0][0];
    expect(callArgs.otherFacts).toEqual([]);
    expect(callArgs.userLocation).toBeNull();
  });

  it('propagates errors from generateTopicsForFact', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'target', questionnaireAttribute: null },
    ]);
    mockGenerateTopicsForFact.mockRejectedValue(new Error('LLM error'));

    const payload: TopicGenPayload = { factId: 'f1', factStatement: 'target' };

    await expect(handleTopicGenJob(payload)).rejects.toThrow('LLM error');
  });

  it('propagates errors from getFacts', async () => {
    mockGetFacts.mockRejectedValue(new Error('DB error'));

    const payload: TopicGenPayload = { factId: 'f1', factStatement: 'target' };

    await expect(handleTopicGenJob(payload)).rejects.toThrow('DB error');
  });
});

// ---------------------------------------------------------------------------
// The SKILL-GUIDED path (pagent P1)
// ---------------------------------------------------------------------------
describe('skill-guided topic generation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFacts.mockResolvedValue([
      { id: 'f1', statement: 'Lives in Alkmaar', metadata: {} },
      { id: 'f2', statement: 'Theatre nurse', metadata: {} },
    ]);
    mockGetActive.mockResolvedValue([]);
    mockGetDeclinedTopicTexts.mockResolvedValue([]);
  });

  it('a payload with NO skillId takes the shipped path, unchanged', async () => {
    // inference_jobs is durable: a job enqueued by an older bundle drains on a
    // later boot and must behave exactly as it did when it was created.
    mockGenerateTopicsForFact.mockResolvedValue(['legacy topic']);

    const out = await handleTopicGenJob({
      factId: 'f1', factStatement: 'Lives in Alkmaar', useCloud: true,
    });

    expect(mockGenerateTopicsForFact).toHaveBeenCalled();
    expect(mockCloudComplete).not.toHaveBeenCalled();
    expect(mockCompleteTopicGeneration).not.toHaveBeenCalled();
    expect(out.topics).toEqual(['legacy topic']);
  });

  it('a payload WITH skillId runs the terminal call and completes through P3', async () => {
    mockCloudComplete.mockResolvedValue('["Alkmaar housing pressure", "Netherlands rail strikes"]');

    const out = await handleTopicGenJob({
      factId: 'f1', factStatement: 'Lives in Alkmaar', useCloud: true, skillId: 'topics/residence',
    });

    expect(mockGenerateTopicsForFact).not.toHaveBeenCalled();
    expect(mockCloudComplete).toHaveBeenCalledTimes(1);   // ONE call. Terminal.
    expect(out.topics).toEqual(['Alkmaar housing pressure', 'Netherlands rail strikes']);
    expect(mockCompleteTopicGeneration).toHaveBeenCalledWith('f1', out.topics);
    expect(mockFailTopicGeneration).not.toHaveBeenCalled();
  });

  it('reads the exclusion lists at RUN time, not from the payload', async () => {
    // A payload snapshot is durable and wrong: two facts accepted in one turn
    // enqueue two jobs in the same tick, so job 2's snapshot predates job 1's
    // writes. The queue drains serially, so only a live read sees them.
    mockGetActive.mockResolvedValue([{ text: 'Alkmaar hospital news' }]);
    mockGetDeclinedTopicTexts.mockResolvedValue(['Alkmaar weather']);
    mockCloudComplete.mockResolvedValue('["Netherlands rail strikes"]');

    await handleTopicGenJob({
      factId: 'f1', factStatement: 'Lives in Alkmaar', useCloud: true, skillId: 'topics/residence',
      // A STALE snapshot on the payload must be ignored entirely.
      excludeTopics: ['something from three days ago'],
    });

    const prompt = mockCloudComplete.mock.calls[0][0].prompt;
    expect(prompt).toContain('Alkmaar hospital news');
    expect(prompt).toContain('Alkmaar weather');
    expect(prompt).not.toContain('something from three days ago');
  });

  it('VETOES a declined text the model returns anyway', async () => {
    mockGetDeclinedTopicTexts.mockResolvedValue(['Alkmaar weather']);
    mockCloudComplete.mockResolvedValue('["Alkmaar weather", "Netherlands rail strikes"]');

    const out = await handleTopicGenJob({
      factId: 'f1', factStatement: 'Lives in Alkmaar', useCloud: true, skillId: 'topics/residence',
    });

    expect(out.topics).toEqual(['Netherlands rail strikes']);
    expect(mockCompleteTopicGeneration).toHaveBeenCalledWith('f1', ['Netherlands rail strikes']);
  });

  it('a read failure degrades to generating WITHOUT exclusions, never a failed job', async () => {
    mockGetActive.mockRejectedValue(new Error('db gone'));
    mockGetDeclinedTopicTexts.mockRejectedValue(new Error('db gone'));
    mockCloudComplete.mockResolvedValue('["Netherlands rail strikes"]');

    const out = await handleTopicGenJob({
      factId: 'f1', factStatement: 'Lives in Alkmaar', useCloud: true, skillId: 'topics/residence',
    });

    expect(out.topics).toEqual(['Netherlands rail strikes']);
    expect(mockFailTopicGeneration).not.toHaveBeenCalled();
  });

  it('records a FAILURE when nothing usable comes back, so the card settles', async () => {
    mockCloudComplete.mockResolvedValue('sorry, I cannot help with that');

    const out = await handleTopicGenJob({
      factId: 'f1', factStatement: 'Lives in Alkmaar', useCloud: true, skillId: 'topics/residence',
    });

    expect(out.topics).toEqual([]);
    expect(mockFailTopicGeneration).toHaveBeenCalledWith('f1', expect.stringContaining('no usable'));
  });

  it('records a FAILURE when the call throws, rather than leaving pending forever', async () => {
    mockCloudComplete.mockRejectedValue(new Error('gateway 502'));

    const out = await handleTopicGenJob({
      factId: 'f1', factStatement: 'Lives in Alkmaar', useCloud: true, skillId: 'topics/residence',
    });

    expect(out.topics).toEqual([]);
    expect(mockFailTopicGeneration).toHaveBeenCalledWith('f1', 'gateway 502');
  });

  it('ON-DEVICE mode keeps the shipped prompt even with a skillId', async () => {
    mockGenerateTopicsForFact.mockResolvedValue(['local topic']);
    const out = await handleTopicGenJob({
      factId: 'f1', factStatement: 'Lives in Alkmaar', useCloud: false, skillId: 'topics/residence',
    });
    expect(mockCloudComplete).not.toHaveBeenCalled();
    expect(out.topics).toEqual(['local topic']);
  });
});
