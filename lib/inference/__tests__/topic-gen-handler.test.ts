// topic-gen-handler.test.ts — the topic_gen job, ISOLATED per fact (ux2 F1).
//
// Every run sees one fact: never another fact, never a location line. Topics
// that need two facts side by side come from the deferred combination pass.

const mockGetFacts = jest.fn();
const mockUpdateFact = jest.fn();
jest.mock('../../database/services/fact-service', () => ({
  getFacts: (...args: unknown[]) => mockGetFacts(...args),
  updateFact: (...args: unknown[]) => mockUpdateFact(...args),
}));

const mockLocalGenerate = jest.fn();
jest.mock('../../mera-protocol/topic-generation-service', () => ({
  generateTopicsForFact: (...args: unknown[]) => mockLocalGenerate(...args),
  mergeTopicsAppend: (a: string[], b: string[]) => [...a, ...b],
}));

const mockNotifyFactMutation = jest.fn();
jest.mock('../../stores/floating-chat-store', () => ({
  useFloatingChatStore: {
    getState: jest.fn(() => ({ notifyFactMutation: mockNotifyFactMutation })),
  },
}));

const mockSyncLlmTopicsForFact = jest.fn((..._args: unknown[]) => Promise.resolve([]));
let mockOwnTopics: { text: string; status: string }[] = [];
jest.mock('../../database/services/topic-service', () => ({
  syncLlmTopicsForFact: (...args: unknown[]) => mockSyncLlmTopicsForFact(...args),
  getByFact: async () => mockOwnTopics,
  normalizeTopicText: (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(),
}));

// Reaches lib/database/index at module scope; mocked at the SERVICE boundary.
let mockDeclined = new Set<string>();
jest.mock('../../database/services/topic-decline-service', () => ({
  getAllDeclinedNormalizedTexts: async () => mockDeclined,
}));

const mockCompleteTopicGeneration = jest.fn(async (..._a: unknown[]) => []);
const mockFailTopicGeneration = jest.fn(async (..._a: unknown[]) => undefined);
const mockMarkTopicGenerationSettled = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('../../database/services/topic-generation-status-service', () => ({
  completeTopicGeneration: (...a: unknown[]) => mockCompleteTopicGeneration(...a),
  failTopicGeneration: (...a: unknown[]) => mockFailTopicGeneration(...a),
  markTopicGenerationSettled: (...a: unknown[]) => mockMarkTopicGenerationSettled(...a),
}));

const mockCloudComplete = jest.fn(async (_req: { systemPrompt: string; prompt: string }) => '[]');
jest.mock('../../llm/cloudComplete', () => ({
  cloudComplete: (req: { systemPrompt: string; prompt: string }) => mockCloudComplete(req),
}));
jest.mock('../../llm/constants', () => ({ SMALL_MODEL: 'test-small' }));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { handleTopicGenJob } from '../handlers/topic-gen-handler';

const HOME = 'location: neighborhood/area, city, and country (preserve specifics)';
const FACTS = [
  { id: 'f1', statement: 'Lives in Alkmaar, North Holland, Netherlands, EU', questionnaireAttribute: HOME },
  { id: 'f2', statement: 'Works as a paediatric nurse', questionnaireAttribute: 'profession: job role and industry' },
  { id: 'f3', statement: 'From India', questionnaireAttribute: 'background: country of origin' },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFacts.mockResolvedValue(FACTS);
  mockOwnTopics = [];
  mockDeclined = new Set();
  mockCloudComplete.mockResolvedValue('["Alkmaar news", "Alkmaar street safety"]');
});

describe('cloud: the skill core, isolated', () => {
  it('sends THIS fact only: no other fact, no location line', async () => {
    await handleTopicGenJob({ factId: 'f2', factStatement: 'Works as a paediatric nurse', useCloud: true });
    const { prompt } = mockCloudComplete.mock.calls[0][0];
    expect(prompt).toContain('paediatric nurse');
    expect(prompt).not.toMatch(/Alkmaar|India|Other user facts|User location/);
  });

  it('derives the guideline from the attribute when the payload names none', async () => {
    await handleTopicGenJob({ factId: 'f1', factStatement: FACTS[0].statement, useCloud: true });
    expect(mockCloudComplete.mock.calls[0][0].systemPrompt).toMatch(/Residence ladders further/);
  });

  it('keeps a skill the chat turn named', async () => {
    await handleTopicGenJob({ factId: 'f3', factStatement: 'From India', useCloud: true, skillId: 'topics/origin' });
    expect(mockCloudComplete.mock.calls[0][0].systemPrompt).toMatch(/id: topics\/origin|diaspora/i);
  });

  it('excludes THIS fact\'s topics and every declined topic, read at run time', async () => {
    mockOwnTopics = [{ text: 'Alkmaar cheese market', status: 'active' }];
    mockDeclined = new Set(['alkmaar weather']);
    await handleTopicGenJob({ factId: 'f1', factStatement: FACTS[0].statement, useCloud: true });
    const { prompt } = mockCloudComplete.mock.calls[0][0];
    expect(prompt).toContain('Alkmaar cheese market');
    expect(prompt).toContain('alkmaar weather');
  });

  it('never mints a declined topic or one the fact already has', async () => {
    mockOwnTopics = [{ text: 'Alkmaar news', status: 'active' }];
    mockDeclined = new Set(['alkmaar street safety']);
    mockCloudComplete.mockResolvedValue('["Alkmaar news", "Alkmaar, street safety!", "North Holland dyke works"]');
    await handleTopicGenJob({ factId: 'f1', factStatement: FACTS[0].statement, useCloud: true, mode: 'append' });
    expect(mockCompleteTopicGeneration).toHaveBeenCalledWith('f1', ['North Holland dyke works']);
  });

  it('an append run that finds nothing new settles, it does not fail', async () => {
    mockOwnTopics = [{ text: 'Alkmaar news', status: 'active' }, { text: 'Alkmaar street safety', status: 'active' }];
    await handleTopicGenJob({ factId: 'f1', factStatement: FACTS[0].statement, useCloud: true, mode: 'append' });
    expect(mockFailTopicGeneration).not.toHaveBeenCalled();
    expect(mockMarkTopicGenerationSettled).toHaveBeenCalledWith(['f1']);
  });

  it('a first run that yields nothing records a failure, so the card settles', async () => {
    mockCloudComplete.mockResolvedValue('[]');
    await handleTopicGenJob({ factId: 'f2', factStatement: 'Works as a paediatric nurse', useCloud: true });
    expect(mockFailTopicGeneration).toHaveBeenCalledWith('f2', expect.any(String));
  });

  it('a throw records a failure rather than leaving pending forever', async () => {
    mockCloudComplete.mockRejectedValue(new Error('boom'));
    await handleTopicGenJob({ factId: 'f2', factStatement: 'Works as a paediatric nurse', useCloud: true });
    expect(mockFailTopicGeneration).toHaveBeenCalledWith('f2', 'boom');
  });

  it('a fact deleted before its job ran is a no-op', async () => {
    const out = await handleTopicGenJob({ factId: 'gone', factStatement: 'x', useCloud: true });
    expect(out.topics).toEqual([]);
    expect(mockCloudComplete).not.toHaveBeenCalled();
    expect(mockFailTopicGeneration).not.toHaveBeenCalled();
  });
});

describe('on-device: the local engine, isolated too', () => {
  it('passes no location and no other facts', async () => {
    mockLocalGenerate.mockResolvedValue(['nurse staffing']);
    mockOwnTopics = [{ text: 'paediatric wards', status: 'active' }];
    mockDeclined = new Set(['nurse pay']);
    await handleTopicGenJob({ factId: 'f2', factStatement: 'Works as a paediatric nurse', useCloud: false });
    expect(mockLocalGenerate).toHaveBeenCalledWith(expect.objectContaining({
      factStatement: 'Works as a paediatric nurse',
      userLocation: null,
      otherFacts: [],
      useCloud: false,
      excludeTopics: ['paediatric wards', 'nurse pay'],
    }));
    expect(mockSyncLlmTopicsForFact).toHaveBeenCalledWith('f2', ['nurse staffing']);
    expect(mockMarkTopicGenerationSettled).toHaveBeenCalledWith(['f2']);
  });
});
