// r12 J-P3 — the weekly fact-combination top-up.
//
// This is the first thing in the app that mints topics UNATTENDED, so the two
// properties that matter most are:
//   • the watermark advances for every fact CONSIDERED, not every fact minted —
//     otherwise a fact that legitimately yields nothing is re-considered every
//     week forever;
//   • the global exclusion set is honoured, because a text collision with a
//     `tracked` topic silently makes a followed story's articles billable again
//     (the stories-quota exemption is live in prod).

const mockKv = new Map<string, string>();

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => {
    mockKv.set(k, v);
  }),
}));

const mockCloudBatchComplete = jest.fn();
jest.mock('@/lib/llm/cloudComplete', () => ({
  cloudBatchComplete: (...a: unknown[]) => mockCloudBatchComplete(...a),
}));

const mockProcessingMode = { value: 'CLOUD' };
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: () => ({ processingMode: mockProcessingMode.value }),
  },
}));
jest.mock('@/lib/generated/graphql-types', () => ({
  ProcessingMode: { Cloud: 'CLOUD', Local: 'LOCAL' },
}));

const mockInFlight = jest.fn((_id: string): boolean => false);
jest.mock('@/lib/chat-tools/tool-handlers', () => ({
  isTopicGenerationInFlight: (id: string) => mockInFlight(id),
}));

const mockGetFacts = jest.fn();
const mockAppendFactMetadataTopics = jest.fn(async () => {});
jest.mock('../fact-service', () => ({
  getFacts: () => mockGetFacts(),
  appendFactMetadataTopics: (...a: unknown[]) => mockAppendFactMetadataTopics(...(a as [])),
}));

const mockGetAllNormalizedTexts = jest.fn(async () => new Set<string>());
const mockGetTopupTopicSnapshots = jest.fn(async () => [] as unknown[]);
const mockAppendTopupTopicsForFact = jest.fn();
jest.mock('../topic-service', () => ({
  getAllNormalizedTexts: () => mockGetAllNormalizedTexts(),
  getTopupTopicSnapshots: () => mockGetTopupTopicSnapshots(),
  appendTopupTopicsForFact: (...a: unknown[]) => mockAppendTopupTopicsForFact(...(a as [])),
  normalizeTopicText: (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' '),
}));

import { runTopicTopup } from '../topic-topup-service';

const OLD = '2026-01-01T00:00:00.000Z';
const NEW = '2026-06-01T00:00:00.000Z';
const NOW = Date.parse('2026-07-01T00:00:00.000Z');

const FACTS = [
  { id: 'f-old', statement: 'Follows the Indian national cricket team', createdAt: OLD },
  { id: 'f-new', statement: 'Lives in Bengaluru', createdAt: NEW },
];

/** f-old's topics predate f-new, so f-old is the top-up candidate. */
const TOPIC_ROWS = [
  { id: 't1', factId: 'f-old', text: 'India cricket news', createdAtMs: Date.parse(OLD), isActive: true },
];

function stateFor(factId: string): number | undefined {
  const raw = mockKv.get('topic_topup_state');
  return raw ? JSON.parse(raw).byFact?.[factId] : undefined;
}

beforeEach(() => {
  mockKv.clear();
  jest.clearAllMocks();
  mockProcessingMode.value = 'CLOUD';
  mockInFlight.mockReturnValue(false);
  mockGetFacts.mockResolvedValue(FACTS);
  mockGetTopupTopicSnapshots.mockResolvedValue(TOPIC_ROWS);
  mockGetAllNormalizedTexts.mockResolvedValue(new Set<string>());
  mockAppendTopupTopicsForFact.mockImplementation(async (_f: string, planned: unknown[]) =>
    planned.map((p: any) => ({ ...p })),
  );
  mockCloudBatchComplete.mockResolvedValue([
    { id: 'topup:f-old', output: '["Bengaluru cricket coverage"]' },
  ]);
});

describe('gating', () => {
  it('does not run on the on-device path', async () => {
    mockProcessingMode.value = 'LOCAL';
    const res = await runTopicTopup({ now: NOW });
    expect(res.reason).toBe('not_cloud');
    expect(mockCloudBatchComplete).not.toHaveBeenCalled();
  });

  it('skips a fact whose generation is already in flight', async () => {
    mockInFlight.mockImplementation((id: string) => id === 'f-old');
    const res = await runTopicTopup({ now: NOW });
    expect(res.reason).toBe('no_candidates');
    expect(mockCloudBatchComplete).not.toHaveBeenCalled();
  });

  it('skips facts a hygiene proposal is about to delete', async () => {
    const res = await runTopicTopup({ now: NOW, excludeFactIds: new Set(['f-old']) });
    expect(res.reason).toBe('no_candidates');
  });

  it('issues ONE batch for the whole sweep', async () => {
    await runTopicTopup({ now: NOW });
    expect(mockCloudBatchComplete).toHaveBeenCalledTimes(1);
  });
});

describe('append-only minting', () => {
  it('appends the generated topic', async () => {
    const res = await runTopicTopup({ now: NOW });
    expect(res).toMatchObject({ ran: true, considered: 1, appended: 1 });
    expect(mockAppendTopupTopicsForFact).toHaveBeenCalledWith('f-old', [
      { text: 'Bengaluru cricket coverage', normalizedText: 'bengaluru cricket coverage' },
    ]);
  });

  it('syncs the legacy metadata list by APPENDING', async () => {
    await runTopicTopup({ now: NOW });
    expect(mockAppendFactMetadataTopics).toHaveBeenCalledWith('f-old', [
      'Bengaluru cricket coverage',
    ]);
  });

  it('EXCLUDES a text a tracked topic already holds', async () => {
    // Live prod behaviour: a metered row carrying a tracked topic's text makes
    // that followed story's articles billable again.
    mockGetAllNormalizedTexts.mockResolvedValue(
      new Set(['bengaluru cricket coverage']),
    );

    const res = await runTopicTopup({ now: NOW });

    expect(res.appended).toBe(0);
    expect(mockAppendTopupTopicsForFact).not.toHaveBeenCalled();
  });

  it('does not re-append a text the sanity pass got retired', async () => {
    mockGetAllNormalizedTexts.mockResolvedValue(
      new Set(['bengaluru cricket coverage']),
    );
    await runTopicTopup({ now: NOW });
    expect(mockAppendTopupTopicsForFact).not.toHaveBeenCalled();
  });

  it('does not let two candidates in one sweep mint the same text', async () => {
    mockGetFacts.mockResolvedValue([
      ...FACTS,
      { id: 'f-old2', statement: 'Watches Test match cricket', createdAt: OLD },
    ]);
    mockGetTopupTopicSnapshots.mockResolvedValue([
      ...TOPIC_ROWS,
      { id: 't2', factId: 'f-old2', text: 'Test cricket news', createdAtMs: Date.parse(OLD), isActive: true },
    ]);
    mockCloudBatchComplete.mockResolvedValue([
      { id: 'topup:f-old', output: '["Bengaluru cricket coverage"]' },
      { id: 'topup:f-old2', output: '["Bengaluru cricket coverage"]' },
    ]);

    const res = await runTopicTopup({ now: NOW });

    expect(res.appended).toBe(1);
    expect(mockAppendTopupTopicsForFact).toHaveBeenCalledTimes(1);
  });
});

describe('watermark — the idempotency mechanism', () => {
  it('advances for a fact that minted rows', async () => {
    await runTopicTopup({ now: NOW });
    expect(stateFor('f-old')).toBe(NOW);
  });

  it('advances even when the model returned nothing', async () => {
    // Otherwise a fact with no genuine combination is re-considered — and
    // re-billed — every single week, forever.
    mockCloudBatchComplete.mockResolvedValue([{ id: 'topup:f-old', output: '[]' }]);

    const res = await runTopicTopup({ now: NOW });

    expect(res.appended).toBe(0);
    expect(stateFor('f-old')).toBe(NOW);
  });

  it('advances even when every candidate text deduped away', async () => {
    mockGetAllNormalizedTexts.mockResolvedValue(new Set(['bengaluru cricket coverage']));
    await runTopicTopup({ now: NOW });
    expect(stateFor('f-old')).toBe(NOW);
  });

  it('advances even when that half errored', async () => {
    mockCloudBatchComplete.mockResolvedValue([
      { id: 'topup:f-old', output: '', error: 'reasoning-overran-budget' },
    ]);
    await runTopicTopup({ now: NOW });
    expect(stateFor('f-old')).toBe(NOW);
  });

  it('does NOT advance when the whole batch failed', async () => {
    mockCloudBatchComplete.mockRejectedValue(new Error('offline'));
    const res = await runTopicTopup({ now: NOW });
    expect(res.reason).toBe('batch_failed');
    expect(stateFor('f-old')).toBeUndefined();
  });

  it('a second run considers nothing new', async () => {
    await runTopicTopup({ now: NOW });
    mockCloudBatchComplete.mockClear();

    const res = await runTopicTopup({ now: NOW + 1000 });

    expect(res.reason).toBe('no_candidates');
    expect(mockCloudBatchComplete).not.toHaveBeenCalled();
  });

  it('re-opens the fact once a genuinely newer fact arrives', async () => {
    await runTopicTopup({ now: NOW });
    mockGetFacts.mockResolvedValue([
      ...FACTS,
      { id: 'f-newest', statement: 'Started a new job in Berlin', createdAt: '2026-08-01T00:00:00.000Z' },
    ]);
    mockCloudBatchComplete.mockResolvedValue([
      { id: 'topup:f-old', output: '["Berlin cricket clubs"]' },
    ]);

    const res = await runTopicTopup({ now: Date.parse('2026-09-01T00:00:00.000Z') });

    expect(res.considered).toBeGreaterThan(0);
  });

  it('prunes watermarks for deleted facts', async () => {
    await runTopicTopup({ now: NOW });
    expect(stateFor('f-old')).toBe(NOW);

    mockGetFacts.mockResolvedValue([FACTS[1]]); // f-old deleted
    await runTopicTopup({ now: NOW + 1000 });

    expect(stateFor('f-old')).toBeUndefined();
  });

  it('recovers from a corrupt state blob rather than wedging', async () => {
    mockKv.set('topic_topup_state', 'not json');
    const res = await runTopicTopup({ now: NOW });
    expect(res.ran).toBe(true);
  });
});
