// r12 K-P5 property (a): generation runs FIRST, and any failure changes NOTHING.
//
// The failure mode this guards: a network drop between "retire the bad topics"
// and "mint the good ones" leaves the user with a fact that lost coverage and
// gained nothing — from rows no server can rebuild.

const mockCloudBatchComplete = jest.fn();
jest.mock('@/lib/llm/cloudComplete', () => ({
  cloudBatchComplete: (...a: unknown[]) => mockCloudBatchComplete(...a),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const mockReplaceTopicsForFact = jest.fn();
const mockGetAllNormalizedTexts = jest.fn(async () => new Set<string>());
const mockGetTopupTopicSnapshots = jest.fn(async () => [] as unknown[]);
jest.mock('../topic-service', () => ({
  replaceTopicsForFact: (...a: unknown[]) => mockReplaceTopicsForFact(...a),
  getAllNormalizedTexts: () => mockGetAllNormalizedTexts(),
  getTopupTopicSnapshots: () => mockGetTopupTopicSnapshots(),
  normalizeTopicText: (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' '),
}));

const mockAppendFactMetadataTopics = jest.fn(async () => {});
const mockGetFacts = jest.fn();
jest.mock('../fact-service', () => ({
  getFacts: () => mockGetFacts(),
  appendFactMetadataTopics: (...a: unknown[]) => mockAppendFactMetadataTopics(...(a as [])),
}));

import { generateAndReplace } from '../topic-replacement-service';

const ISO = '2026-01-01T00:00:00.000Z';

const FACTS = [
  { id: 'f1', statement: 'Follows the Indian national cricket team', createdAt: ISO },
  { id: 'f2', statement: 'Lives in Amsterdam', createdAt: ISO },
];

const TOPIC_ROWS = [
  { id: 't-bad', factId: 'f1', text: 'Amsterdam cricket festival music tech', createdAtMs: 1, isActive: true },
  { id: 't-ok', factId: 'f1', text: 'India cricket news', createdAtMs: 1, isActive: true },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFacts.mockResolvedValue(FACTS);
  mockGetTopupTopicSnapshots.mockResolvedValue(TOPIC_ROWS);
  mockGetAllNormalizedTexts.mockResolvedValue(new Set<string>());
  mockReplaceTopicsForFact.mockResolvedValue({
    minted: [{ text: 'Netherlands cricket diaspora broadcasts' }],
    retired: ['t-bad'],
    floorHeld: false,
  });
});

describe('(a) generation failure changes NOTHING', () => {
  it('does not touch the database when the batch call rejects', async () => {
    mockCloudBatchComplete.mockRejectedValue(new Error('network down'));

    const out = await generateAndReplace('f1', 3, ['t-bad']);

    expect(out.ok).toBe(false);
    expect(mockReplaceTopicsForFact).not.toHaveBeenCalled();
    expect(mockAppendFactMetadataTopics).not.toHaveBeenCalled();
  });

  it('does not touch the database when the result carries an error', async () => {
    mockCloudBatchComplete.mockResolvedValue([
      { id: 'topup:f1', output: '', error: 'reasoning-overran-budget' },
    ]);

    const out = await generateAndReplace('f1', 3, ['t-bad']);

    expect(out.ok).toBe(false);
    expect(mockReplaceTopicsForFact).not.toHaveBeenCalled();
  });

  it('does not touch the database when the batch returns nothing', async () => {
    mockCloudBatchComplete.mockResolvedValue([]);

    const out = await generateAndReplace('f1', 3, ['t-bad']);

    expect(out.ok).toBe(false);
    expect(mockReplaceTopicsForFact).not.toHaveBeenCalled();
  });

  it('does not touch the database for an unknown fact', async () => {
    const out = await generateAndReplace('ghost', 3, ['t-bad']);

    expect(out.ok).toBe(false);
    expect(mockCloudBatchComplete).not.toHaveBeenCalled();
    expect(mockReplaceTopicsForFact).not.toHaveBeenCalled();
  });
});

describe('happy path', () => {
  it('generates, then replaces, then syncs the legacy metadata list', async () => {
    mockCloudBatchComplete.mockResolvedValue([
      { id: 'topup:f1', output: '["Netherlands cricket diaspora broadcasts"]' },
    ]);

    const out = await generateAndReplace('f1', 3, ['t-bad']);

    expect(out).toEqual({ ok: true, minted: 1, retired: 1, floorHeld: false });
    // Ordering is the safety property: generation happened before the write.
    expect(mockCloudBatchComplete).toHaveBeenCalled();
    expect(mockReplaceTopicsForFact).toHaveBeenCalledWith(
      'f1',
      [expect.objectContaining({ text: 'Netherlands cricket diaspora broadcasts' })],
      ['t-bad'],
    );
    expect(mockAppendFactMetadataTopics).toHaveBeenCalled();
  });

  it('issues exactly ONE combo-only call with thinking on', async () => {
    mockCloudBatchComplete.mockResolvedValue([
      { id: 'topup:f1', output: '["Netherlands cricket diaspora broadcasts"]' },
    ]);

    await generateAndReplace('f1', 3, ['t-bad']);

    const [calls] = mockCloudBatchComplete.mock.calls[0] as [any[]];
    expect(calls).toHaveLength(1);
    expect(calls[0].enableThinking).toBe(true);
    expect(calls[0].system).toContain('combine the Fact');
  });

  it('EXCLUDES a text a tracked topic already holds', async () => {
    // Live prod behaviour since the stories-quota exemption shipped: a metered
    // row colliding with a tracked topic's text makes that followed story's
    // articles billable again.
    mockGetAllNormalizedTexts.mockResolvedValue(
      new Set(['netherlands cricket diaspora broadcasts']),
    );
    mockCloudBatchComplete.mockResolvedValue([
      { id: 'topup:f1', output: '["Netherlands cricket diaspora broadcasts"]' },
    ]);

    await generateAndReplace('f1', 3, ['t-bad']);

    // Nothing planned → the floor decides whether the retire may proceed.
    expect(mockReplaceTopicsForFact).toHaveBeenCalledWith('f1', [], ['t-bad']);
  });

  it('surfaces floorHeld so the caller does not claim a cleanup that did not happen', async () => {
    mockReplaceTopicsForFact.mockResolvedValue({
      minted: [],
      retired: [],
      floorHeld: true,
    });
    mockCloudBatchComplete.mockResolvedValue([{ id: 'topup:f1', output: '[]' }]);

    const out = await generateAndReplace('f1', 3, ['t-bad']);

    expect(out).toEqual({ ok: true, minted: 0, retired: 0, floorHeld: true });
  });

  it('unparseable model output still reaches the floor rather than failing open', async () => {
    mockCloudBatchComplete.mockResolvedValue([
      { id: 'topup:f1', output: 'not json at all' },
    ]);
    mockReplaceTopicsForFact.mockResolvedValue({
      minted: [],
      retired: [],
      floorHeld: true,
    });

    const out = await generateAndReplace('f1', 3, ['t-bad']);

    expect(out.ok).toBe(true);
    expect(mockReplaceTopicsForFact).toHaveBeenCalledWith('f1', [], ['t-bad']);
  });
});
