// topic-combo-handler — the deferred combination pass, one batched cloud call
// per claimed group of same-pass facts (ux2 F3).

const mockReadMode = jest.fn(async () => 'CLOUD');
const mockClaimSiblings = jest.fn(async (..._a: unknown[]) => [] as { jobId: string; factId: string }[]);
const mockRelease = jest.fn(async (..._a: unknown[]) => undefined);
const mockApply = jest.fn(async (..._a: unknown[]) => ({ kept: 0, inserted: 0, retired: 0, destroyed: 0 }));
const mockDropPending = jest.fn(async () => 0);
jest.mock('../../database/services/combo-pass-service', () => ({
  COMBO_SIBLING_LIMIT: 8,
  readProcessingModeSetting: () => mockReadMode(),
  claimSiblings: (...a: unknown[]) => mockClaimSiblings(...a),
  releaseComboJobs: (...a: unknown[]) => mockRelease(...a),
  applyComboTopicsForFact: (...a: unknown[]) => mockApply(...a),
  dropPendingComboJobs: () => mockDropPending(),
}));
let mockFacts: { id: string; statement: string }[] = [];
jest.mock('../../database/services/fact-service', () => ({ getFacts: async () => mockFacts }));
let mockAllTexts = new Set<string>();
jest.mock('../../database/services/topic-service', () => ({
  getAllNormalizedTexts: async () => mockAllTexts,
  normalizeTopicText: (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(),
}));
let mockDeclined = new Set<string>();
jest.mock('../../database/services/topic-decline-service', () => ({
  getAllDeclinedNormalizedTexts: async () => mockDeclined,
}));
const mockBatch = jest.fn();
jest.mock('../../llm/cloudComplete', () => ({
  cloudBatchComplete: (...a: unknown[]) => mockBatch(...a),
}));
jest.mock('../../llm/constants', () => ({ SMALL_MODEL: 'test-small' }));
jest.mock('../../generated/graphql-types', () => ({ ProcessingMode: { Cloud: 'CLOUD', OnDevice: 'ON_DEVICE' } }));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { COMBO_PASS_TOPIC_SYSTEM_PROMPT } from '../../news-harness/prompts/persona-prompts';
import { handleTopicComboJob } from '../handlers/topic-combo-handler';

const ok = (id: string, arr: string[]) => ({ id, output: JSON.stringify(arr) });

beforeEach(() => {
  jest.clearAllMocks();
  mockReadMode.mockResolvedValue('CLOUD');
  mockClaimSiblings.mockResolvedValue([]);
  mockAllTexts = new Set();
  mockDeclined = new Set();
  // Newest first, as getFacts returns them.
  mockFacts = [
    { id: 'f1', statement: 'Works as a nurse' },
    { id: 'f2', statement: 'Lives in Porto, Portugal, EU' },
    { id: 'f3', statement: 'From India' },
  ];
});

it('claims same-pass siblings up to the gateway concurrency, in ONE batched call', async () => {
  mockClaimSiblings.mockResolvedValue([{ jobId: 'j2', factId: 'f2' }]);
  mockBatch.mockResolvedValue([ok('j1', ['Portugal nurse pay dispute']), ok('j2', ['Porto India flights'])]);
  await handleTopicComboJob({ factId: 'f1', passId: 'p1' }, { jobId: 'j1' });
  expect(mockClaimSiblings).toHaveBeenCalledWith('p1', 7);
  expect(mockBatch).toHaveBeenCalledTimes(1);
  const [calls] = mockBatch.mock.calls[0] as [{ id: string; system: string; prompt: string; enableThinking?: boolean }[]];
  expect(calls.map((c) => c.id)).toEqual(['j1', 'j2']);
  expect(calls[0].system).toBe(COMBO_PASS_TOPIC_SYSTEM_PROMPT);
  expect(calls[0].prompt).toBe(
    'Fact: "Works as a nurse"\nOther user facts: Lives in Porto, Portugal, EU; From India\nGenerate at most 4 topics',
  );
  expect(calls[0].prompt).not.toMatch(/User location/);
  expect(calls[0].enableThinking).toBe(false);
  expect(mockApply).toHaveBeenCalledWith('f1', ['Portugal nurse pay dispute'], 'j1');
  expect(mockApply).toHaveBeenCalledWith('f2', ['Porto India flights'], 'j2');
});

it('caps the supporting facts at 25, newest first', async () => {
  mockFacts = [{ id: 'f0', statement: 'Fact zero' }, ...Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, statement: `Support ${i}` }))];
  mockBatch.mockResolvedValue([ok('j1', [])]);
  await handleTopicComboJob({ factId: 'f0', passId: 'p1' }, { jobId: 'j1' });
  const prompt = (mockBatch.mock.calls[0][0] as { prompt: string }[])[0].prompt;
  expect(prompt).toContain('Support 0; ');
  expect(prompt).toContain('Support 24');
  expect(prompt).not.toContain('Support 25');
});

it('dedupes against every topic on the device, the declined list, and across the batch', async () => {
  mockClaimSiblings.mockResolvedValue([{ jobId: 'j2', factId: 'f2' }]);
  mockAllTexts = new Set(['portugal nurse pay dispute']);
  mockDeclined = new Set(['india nurse voting rights']);
  mockBatch.mockResolvedValue([
    ok('j1', ['Portugal nurse pay dispute', 'India nurse voting rights', 'Porto nurse India recruitment']),
    ok('j2', ['Porto nurse recruitment India', 'Porto India direct flights']),
  ]);
  await handleTopicComboJob({ factId: 'f1', passId: 'p1' }, { jobId: 'j1' });
  expect(mockApply).toHaveBeenCalledWith('f1', ['Porto nurse India recruitment'], 'j1');
  expect(mockApply).toHaveBeenCalledWith('f2', ['Porto India direct flights'], 'j2');
});

it('on-device mode runs no pass and drops the pending combo jobs', async () => {
  mockReadMode.mockResolvedValue('ON_DEVICE');
  await handleTopicComboJob({ factId: 'f1', passId: 'p1' }, { jobId: 'j1' });
  expect(mockBatch).not.toHaveBeenCalled();
  expect(mockDropPending).toHaveBeenCalled();
  expect(mockClaimSiblings).not.toHaveBeenCalled();
});

it('a fact deleted since the pass was queued is a no-op that still settles its job', async () => {
  mockBatch.mockResolvedValue([]);
  await handleTopicComboJob({ factId: 'gone', passId: 'p1' }, { jobId: 'j1' });
  expect(mockBatch).not.toHaveBeenCalled();
  expect(mockApply).toHaveBeenCalledWith('gone', [], 'j1');
});

it('an offline or credential-less failure DEFERS the claimed siblings and rethrows for the head', async () => {
  mockClaimSiblings.mockResolvedValue([{ jobId: 'j2', factId: 'f2' }]);
  const err = Object.assign(new Error('no credential'), { name: 'NoCredentialError' });
  mockBatch.mockRejectedValue(err);
  await expect(handleTopicComboJob({ factId: 'f1', passId: 'p1' }, { jobId: 'j1' })).rejects.toBe(err);
  expect(mockRelease).toHaveBeenCalledWith(['j2'], 'defer');
  expect(mockApply).not.toHaveBeenCalled();
});

it('any other failure gives the siblings back WITH the error, attempt kept', async () => {
  mockClaimSiblings.mockResolvedValue([{ jobId: 'j2', factId: 'f2' }]);
  mockBatch.mockRejectedValue(new Error('boom'));
  await expect(handleTopicComboJob({ factId: 'f1', passId: 'p1' }, { jobId: 'j1' })).rejects.toThrow('boom');
  expect(mockRelease).toHaveBeenCalledWith(['j2'], { error: 'boom' });
});

it('a per-call error fails that sibling alone; the head still applies', async () => {
  mockClaimSiblings.mockResolvedValue([{ jobId: 'j2', factId: 'f2' }]);
  mockBatch.mockResolvedValue([ok('j1', ['Portugal nurse pay dispute']), { id: 'j2', output: '', error: 'E2EE decrypt failed' }]);
  await handleTopicComboJob({ factId: 'f1', passId: 'p1' }, { jobId: 'j1' });
  expect(mockApply).toHaveBeenCalledWith('f1', ['Portugal nurse pay dispute'], 'j1');
  expect(mockRelease).toHaveBeenCalledWith(['j2'], { error: 'E2EE decrypt failed' });
});

it('a per-call error on the head applies the siblings, then throws for the head', async () => {
  mockClaimSiblings.mockResolvedValue([{ jobId: 'j2', factId: 'f2' }]);
  mockBatch.mockResolvedValue([{ id: 'j1', output: '', error: 'timeout' }, ok('j2', ['Porto India direct flights'])]);
  await expect(handleTopicComboJob({ factId: 'f1', passId: 'p1' }, { jobId: 'j1' })).rejects.toThrow('timeout');
  expect(mockApply).toHaveBeenCalledWith('f2', ['Porto India direct flights'], 'j2');
  expect(mockRelease).not.toHaveBeenCalled();
});


it('ux2 F6: drops a combination topic that does not name its own fact', async () => {
  mockBatch.mockResolvedValue([ok('j1', ['Portugal nurse pay dispute', 'Porto India direct flights'])]);
  await handleTopicComboJob({ factId: 'f1', passId: 'p1' }, { jobId: 'j1' });
  expect(mockApply).toHaveBeenCalledWith('f1', ['Portugal nurse pay dispute'], 'j1');
});
