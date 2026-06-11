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

jest.mock('../../stores/chat-popup-store', () => ({
  useChatPopupStore: {
    getState: jest.fn(() => ({ notifyFactMutation: mockNotifyFactMutation })),
  },
}));

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
    expect(mockNotifyFactMutation).toHaveBeenCalled();
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
