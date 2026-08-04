// r12 K-P5 — the one-time backfill state machine.
//
// The two failure modes this must not have:
//   1. re-running from scratch on every launch (would re-audit the whole corpus
//      repeatedly and bill for it);
//   2. marking itself done having processed half the corpus (would leave the
//      contamination the pass exists to clear, permanently, behind a flag that
//      says it is finished).

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

const mockGetFacts = jest.fn(async () => [{ id: 'f1', statement: 'Follows cricket' }]);
jest.mock('../fact-service', () => ({ getFacts: () => mockGetFacts() }));

const mockRunSanityAudit = jest.fn();
const mockResetSanityCursor = jest.fn(async () => {});
jest.mock('../topic-sanity-service', () => ({
  runSanityAudit: (...a: unknown[]) => mockRunSanityAudit(...(a as [])),
  resetSanityCursor: () => mockResetSanityCursor(),
}));

type AddOpts = { notify: boolean; now: number } | undefined;
const mockAddSanityProposals = jest.fn(
  async (_verdicts: unknown, _opts: AddOpts): Promise<number> => 0,
);
jest.mock('../hygiene-service', () => ({
  addSanityProposals: (a: unknown, b: unknown) =>
    mockAddSanityProposals(a, b as AddOpts),
}));

import {
  runSanityBackfillChunk,
  isBackfillDone,
  SANITY_BACKFILL_MAX_TOPICS,
  BACKFILL_CHUNK_TOPICS,
} from '../sanity-backfill-service';

beforeEach(() => {
  mockKv.clear();
  jest.clearAllMocks();
  mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Follows cricket' }]);
  mockAddSanityProposals.mockResolvedValue(0);
  mockRunSanityAudit.mockResolvedValue({ incoherentFacts: [], audited: 60 });
});

describe('starting the pass', () => {
  it('resets the audit cursor on the FIRST run so pre-fix topics are re-judged', async () => {
    await runSanityBackfillChunk();
    expect(mockResetSanityCursor).toHaveBeenCalledTimes(1);
  });

  it('does NOT reset the cursor again on later runs', async () => {
    await runSanityBackfillChunk();
    await runSanityBackfillChunk();
    await runSanityBackfillChunk();
    // Failure mode 1: a relaunch must not rewind and re-audit from scratch.
    expect(mockResetSanityCursor).toHaveBeenCalledTimes(1);
  });

  it('audits in bounded chunks, then yields', async () => {
    await runSanityBackfillChunk();
    expect(mockRunSanityAudit).toHaveBeenCalledWith(
      expect.objectContaining({ maxTopics: BACKFILL_CHUNK_TOPICS }),
    );
  });

  it('does not start (or burn the flag) when there are no facts', async () => {
    mockGetFacts.mockResolvedValue([]);
    const res = await runSanityBackfillChunk();
    expect(res.reason).toBe('no_facts');
    expect(await isBackfillDone()).toBe(false);
  });
});

describe('completion is DERIVED, never "we ran"', () => {
  it('is not done while chunks are still returning work', async () => {
    const res = await runSanityBackfillChunk();
    expect(res.done).toBe(false);
    expect(await isBackfillDone()).toBe(false);
  });

  it('completes only when a chunk finds nothing left to audit', async () => {
    await runSanityBackfillChunk(); // 60 audited
    mockRunSanityAudit.mockResolvedValue({ incoherentFacts: [], audited: 0 });

    const res = await runSanityBackfillChunk();

    expect(res.done).toBe(true);
    expect(await isBackfillDone()).toBe(true);
  });

  it('a chunk killed midway does NOT mark itself done', async () => {
    // Failure mode 2: the audit throws partway; the pass must stay resumable.
    mockRunSanityAudit.mockRejectedValue(new Error('app backgrounded'));

    const res = await runSanityBackfillChunk();

    expect(res.done).toBe(false);
    expect(await isBackfillDone()).toBe(false);
  });

  it('resumes after a failure without rewinding the cursor', async () => {
    mockRunSanityAudit.mockRejectedValueOnce(new Error('network'));
    await runSanityBackfillChunk();
    mockRunSanityAudit.mockResolvedValue({ incoherentFacts: [], audited: 60 });
    await runSanityBackfillChunk();

    expect(mockResetSanityCursor).toHaveBeenCalledTimes(1);
  });

  it('stops at the hard ceiling rather than running unbounded', async () => {
    const chunks = SANITY_BACKFILL_MAX_TOPICS / BACKFILL_CHUNK_TOPICS;
    for (let i = 0; i < chunks; i += 1) await runSanityBackfillChunk();

    expect(await isBackfillDone()).toBe(true);
  });

  it('every call after completion is a cheap no-op', async () => {
    mockRunSanityAudit.mockResolvedValue({ incoherentFacts: [], audited: 0 });
    await runSanityBackfillChunk();
    mockRunSanityAudit.mockClear();
    mockGetFacts.mockClear();

    const res = await runSanityBackfillChunk();

    expect(res.reason).toBe('already_done');
    expect(mockRunSanityAudit).not.toHaveBeenCalled();
    expect(mockGetFacts).not.toHaveBeenCalled();
  });
});

describe('proposals and notification', () => {
  const verdicts = { incoherentFacts: [{ factId: 'f1', topicIds: ['t1'], fillTo: 3 }], audited: 60 };

  it('feeds verdicts through the capped/refilling review queue', async () => {
    mockRunSanityAudit.mockResolvedValue(verdicts);
    mockAddSanityProposals.mockResolvedValue(1);

    const res = await runSanityBackfillChunk();

    expect(mockAddSanityProposals).toHaveBeenCalledWith(
      verdicts.incoherentFacts,
      expect.objectContaining({ notify: true }),
    );
    expect(res.proposalsAdded).toBe(1);
  });

  it('notifies ONCE for the whole pass, not once per chunk', async () => {
    mockRunSanityAudit.mockResolvedValue(verdicts);
    mockAddSanityProposals.mockResolvedValue(1);

    await runSanityBackfillChunk();
    await runSanityBackfillChunk();
    await runSanityBackfillChunk();

    const notifyFlags = mockAddSanityProposals.mock.calls.map(
      (c) => c[1]?.notify,
    );
    expect(notifyFlags).toEqual([true, false, false]);
  });

  it('does not consume the notification when nothing was added', async () => {
    mockRunSanityAudit.mockResolvedValue(verdicts);
    mockAddSanityProposals.mockResolvedValue(0); // all already pending

    await runSanityBackfillChunk();
    await runSanityBackfillChunk();

    const notifyFlags = mockAddSanityProposals.mock.calls.map(
      (c) => c[1]?.notify,
    );
    expect(notifyFlags).toEqual([true, true]);
  });

  it('skips the queue entirely when a chunk finds nothing wrong', async () => {
    await runSanityBackfillChunk();
    expect(mockAddSanityProposals).not.toHaveBeenCalled();
  });
});
