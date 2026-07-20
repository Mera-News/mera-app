// persona-summary-handler tests — mock the DB services + LLM transport, assert
// the persona → LLM → strict-JSON → write-table flow (cloud + on-device, empty
// persona, malformed output, transport failure).

const mockGetFacts = jest.fn();
const mockGetFactSectionSnapshots = jest.fn();
jest.mock('../../../database/services/fact-service', () => ({
  getFacts: (...a: unknown[]) => mockGetFacts(...a),
  getFactSectionSnapshots: (...a: unknown[]) => mockGetFactSectionSnapshots(...a),
}));

const mockGetActiveTopicSnapshots = jest.fn();
jest.mock('../../../database/services/topic-service', () => ({
  getActiveTopicSnapshots: (...a: unknown[]) => mockGetActiveTopicSnapshots(...a),
}));

const mockReplaceAll = jest.fn();
jest.mock('../../../database/services/persona-summary-service', () => ({
  replaceAllSummaryStrings: (...a: unknown[]) => mockReplaceAll(...a),
}));

const mockCloudComplete = jest.fn();
jest.mock('../../../llm/cloudComplete', () => ({
  cloudComplete: (...a: unknown[]) => mockCloudComplete(...a),
}));

const mockCompleteLocal = jest.fn();
jest.mock('../../../llm/completeLocal', () => ({
  completeLocal: (...a: unknown[]) => mockCompleteLocal(...a),
}));

jest.mock('../../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import {
  handlePersonaSummaryJob,
  buildPersonaSummaryInputs,
} from '../persona-summary-handler';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFacts.mockResolvedValue([
    { id: 'fact-A', statement: 'Lives in Pune' },
    { id: 'fact-B', statement: 'Works in AI' },
  ]);
  mockGetFactSectionSnapshots.mockResolvedValue([
    { id: 'fact-A', weight: 1 },
    { id: 'fact-B', weight: 2 },
  ]);
  mockGetActiveTopicSnapshots.mockResolvedValue([
    { id: 't1', factId: 'fact-A', weight: 0.5, highPriority: false },
    { id: 't2', factId: 'fact-B', weight: 0.5, highPriority: false },
  ]);
  mockReplaceAll.mockResolvedValue(undefined);
});

describe('buildPersonaSummaryInputs', () => {
  it('joins facts with weights and their owned topic ids', async () => {
    const inputs = await buildPersonaSummaryInputs();
    expect(inputs).toEqual([
      { factId: 'fact-A', statement: 'Lives in Pune', weight: 1, topicIds: ['t1'] },
      { factId: 'fact-B', statement: 'Works in AI', weight: 2, topicIds: ['t2'] },
    ]);
  });
});

describe('handlePersonaSummaryJob — cloud', () => {
  it('generates via cloudComplete and writes assembled strings', async () => {
    // fact-B has weight 2 → it is index 1 after selection sort.
    mockCloudComplete.mockResolvedValue(
      '[{"text":"Works in AI","facts":[1]},{"text":"Lives in Pune","facts":[2]}]',
    );

    const result = await handlePersonaSummaryJob({ useCloud: true, personaVersion: 'v1:2:x' });

    expect(mockCloudComplete).toHaveBeenCalled();
    expect(mockCompleteLocal).not.toHaveBeenCalled();
    expect(result.count).toBe(2);
    expect(mockReplaceAll).toHaveBeenCalledTimes(1);
    const [results, version] = mockReplaceAll.mock.calls[0];
    expect(version).toBe('v1:2:x');
    expect(results).toEqual([
      { text: 'Works in AI', linkedFactIds: ['fact-B'], linkedTopicIds: ['t2'] },
      { text: 'Lives in Pune', linkedFactIds: ['fact-A'], linkedTopicIds: ['t1'] },
    ]);
  });
});

describe('handlePersonaSummaryJob — on-device', () => {
  it('generates via completeLocal', async () => {
    mockCompleteLocal.mockResolvedValue('[{"text":"Works in AI","facts":[1]}]');
    const result = await handlePersonaSummaryJob({ useCloud: false, personaVersion: 'v' });
    expect(mockCompleteLocal).toHaveBeenCalled();
    expect(mockCloudComplete).not.toHaveBeenCalled();
    expect(result.count).toBe(1);
    expect(mockReplaceAll).toHaveBeenCalled();
  });
});

describe('handlePersonaSummaryJob — edge cases', () => {
  it('empty persona → clears strings', async () => {
    mockGetFacts.mockResolvedValue([]);
    mockGetFactSectionSnapshots.mockResolvedValue([]);
    mockGetActiveTopicSnapshots.mockResolvedValue([]);
    const result = await handlePersonaSummaryJob({ useCloud: true, personaVersion: 'v' });
    expect(result.count).toBe(0);
    expect(mockReplaceAll).toHaveBeenCalledWith([], 'v');
    expect(mockCloudComplete).not.toHaveBeenCalled();
  });

  it('malformed model output → keeps previous strings (no write)', async () => {
    mockCloudComplete.mockResolvedValue('sorry, I cannot help with that');
    const result = await handlePersonaSummaryJob({ useCloud: true });
    expect(result.count).toBe(0);
    expect(mockReplaceAll).not.toHaveBeenCalled();
  });

  it('transport failure → keeps previous strings (no write)', async () => {
    mockCloudComplete.mockRejectedValue(new Error('network'));
    const result = await handlePersonaSummaryJob({ useCloud: true });
    expect(result.count).toBe(0);
    expect(mockReplaceAll).not.toHaveBeenCalled();
  });

  it('valid JSON but no usable strings → no write', async () => {
    mockCloudComplete.mockResolvedValue('[]');
    const result = await handlePersonaSummaryJob({ useCloud: true });
    expect(result.count).toBe(0);
    expect(mockReplaceAll).not.toHaveBeenCalled();
  });
});
