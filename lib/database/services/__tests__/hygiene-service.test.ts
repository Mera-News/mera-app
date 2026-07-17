// hygiene-service unit tests — the sweep guards, notification firing, and
// accept/reject routing, with every underlying service mocked. The pure
// analyzer (fact-hygiene) runs for real so the wiring is exercised end-to-end.

const mockKv = new Map<string, string>();

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(() => 'evt') },
}));

jest.mock('@/lib/toast-manager', () => ({
  toastManager: {
    showNotifiedToast: jest.fn(async () => {}),
    showSuccess: jest.fn(() => {}),
    showError: jest.fn(() => {}),
  },
}));

jest.mock('../setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => {
    mockKv.set(k, v);
  }),
}));

jest.mock('../fact-service', () => ({
  getFacts: jest.fn(async () => []),
  getFactSectionSnapshots: jest.fn(async () => []),
  deleteFact: jest.fn(async () => {}),
}));

jest.mock('../topic-service', () => ({
  getAllTopicSnapshots: jest.fn(async () => []),
}));

jest.mock('../persona-action-executor', () => ({
  applyPersonaAction: jest.fn(async () => ({ applied: true, summary: 'ok' })),
}));

jest.mock('../persona-change-log-service', () => ({
  append: jest.fn(async () => ({ id: 'cl-1' })),
}));

import {
  runHygieneSweep,
  getPendingProposals,
  getPendingCount,
  acceptProposal,
  rejectProposal,
  MIN_FACTS_FOR_SWEEP,
} from '../hygiene-service';
import * as factService from '../fact-service';
import * as topicService from '../topic-service';
import * as executor from '../persona-action-executor';
import * as changeLog from '../persona-change-log-service';
import { toastManager } from '@/lib/toast-manager';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** Build N facts; index 0 is a single-word "News" fact (→ too_broad). */
function seedFacts(n: number) {
  const facts = Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    statement: i === 0 ? 'News' : `distinct interest number ${i}`,
    metadata: {},
    createdAt: new Date(NOW - 100 * DAY).toISOString(),
    updatedAt: new Date(NOW - 100 * DAY).toISOString(),
  }));
  const snapshots = facts.map((f, i) => ({
    id: f.id,
    weight: i === 0 ? 0.9 : 0.5,
    createdAtMs: NOW - 100 * DAY,
    statement: f.statement,
    sectionTitle: null,
  }));
  (factService.getFacts as jest.Mock).mockResolvedValue(facts);
  (factService.getFactSectionSnapshots as jest.Mock).mockResolvedValue(snapshots);
  (topicService.getAllTopicSnapshots as jest.Mock).mockResolvedValue([]);
}

beforeEach(() => {
  mockKv.clear();
  jest.clearAllMocks();
  (factService.getFacts as jest.Mock).mockResolvedValue([]);
  (factService.getFactSectionSnapshots as jest.Mock).mockResolvedValue([]);
  (topicService.getAllTopicSnapshots as jest.Mock).mockResolvedValue([]);
  (executor.applyPersonaAction as jest.Mock).mockResolvedValue({ applied: true, summary: 'ok' });
});

describe('runHygieneSweep — guards', () => {
  it('skips when there are too few facts', async () => {
    seedFacts(MIN_FACTS_FOR_SWEEP - 1);
    const res = await runHygieneSweep({ now: NOW });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('too_few_facts');
  });

  it('skips when the persona is younger than the min age', async () => {
    seedFacts(MIN_FACTS_FOR_SWEEP);
    (factService.getFactSectionSnapshots as jest.Mock).mockResolvedValue(
      Array.from({ length: MIN_FACTS_FOR_SWEEP }, (_, i) => ({
        id: `f${i}`,
        weight: 0.5,
        createdAtMs: NOW - 2 * DAY, // 2 days old < 7d
        statement: 'x',
        sectionTitle: null,
      })),
    );
    const res = await runHygieneSweep({ now: NOW });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('persona_too_young');
  });

  it('skips on cooldown when a recent sweep stamp exists', async () => {
    mockKv.set('hygiene_last_sweep_at', String(NOW - DAY)); // 1 day ago < 6d
    seedFacts(MIN_FACTS_FOR_SWEEP);
    const res = await runHygieneSweep({ now: NOW });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('cooldown');
  });

  it('force bypasses the cooldown', async () => {
    mockKv.set('hygiene_last_sweep_at', String(NOW - DAY));
    seedFacts(MIN_FACTS_FOR_SWEEP);
    const res = await runHygieneSweep({ now: NOW, force: true });
    expect(res.ran).toBe(true);
  });
});

describe('runHygieneSweep — analysis + notification', () => {
  it('stores proposals and fires ONE hygiene notification with the count', async () => {
    seedFacts(MIN_FACTS_FOR_SWEEP);
    const res = await runHygieneSweep({ now: NOW });
    expect(res.ran).toBe(true);
    expect(res.proposalCount).toBeGreaterThan(0);

    // Persisted + retrievable.
    const pending = await getPendingProposals();
    expect(pending.length).toBe(res.proposalCount);
    expect(await getPendingCount()).toBe(res.proposalCount);

    // Exactly one notification with type hygiene + review chip + count context.
    expect(toastManager.showNotifiedToast).toHaveBeenCalledTimes(1);
    const arg = (toastManager.showNotifiedToast as jest.Mock).mock.calls[0][0];
    expect(arg.type).toBe('hygiene');
    expect(arg.icon).toBe('cleaning-services');
    expect(arg.context).toEqual({ count: res.proposalCount });
    expect(arg.actions).toEqual([{ id: 'review-hygiene', labelKey: 'hygiene.reviewChip' }]);

    // Cooldown stamp written.
    expect(mockKv.get('hygiene_last_sweep_at')).toBe(String(NOW));
  });

  it('does not fire a notification when there are no proposals', async () => {
    // 10 multi-word facts, no topics → nothing to clean.
    const facts = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`,
      statement: `a distinct multi word interest ${i}`,
      metadata: {},
      createdAt: '',
      updatedAt: '',
    }));
    (factService.getFacts as jest.Mock).mockResolvedValue(facts);
    (factService.getFactSectionSnapshots as jest.Mock).mockResolvedValue(
      facts.map((f) => ({ id: f.id, weight: 0.5, createdAtMs: NOW - 100 * DAY, statement: f.statement, sectionTitle: null })),
    );
    const res = await runHygieneSweep({ now: NOW });
    expect(res.ran).toBe(true);
    expect(res.proposalCount).toBe(0);
    expect(toastManager.showNotifiedToast).not.toHaveBeenCalled();
  });
});

describe('acceptProposal', () => {
  it('routes a persona_action op through the executor and clears it from pending', async () => {
    seedFacts(MIN_FACTS_FOR_SWEEP);
    await runHygieneSweep({ now: NOW });
    const [proposal] = await getPendingProposals();
    expect(proposal.kind).toBe('too_broad_fact');

    const res = await acceptProposal(proposal.id);
    expect(res.applied).toBe(true);
    expect(res.ok).toBe(true);
    expect(executor.applyPersonaAction).toHaveBeenCalledWith(
      expect.objectContaining({ action_type: ACTION_NAMES.SET_FACT_WEIGHT, factId: 'f0' }),
      'digest',
    );
    expect(await getPendingCount()).toBe(0);
  });

  it('routes a delete_fact op through fact-service + a change-log row', async () => {
    // Seed a delete proposal directly into pending KV.
    const proposal = {
      id: 'stale_fact:fx',
      kind: 'stale_fact',
      summary: 'Removed defunct fact',
      targetFactIds: ['fx'],
      targetTopicIds: [],
      ops: [{ type: 'delete_fact', factId: 'fx' }],
      invertible: false,
    };
    mockKv.set('hygiene_pending_proposals', JSON.stringify([proposal]));

    const res = await acceptProposal('stale_fact:fx');
    expect(res.applied).toBe(true);
    expect(factService.deleteFact).toHaveBeenCalledWith('fx');
    expect(changeLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: ACTION_NAMES.HYGIENE_DELETE_FACT,
        source: 'digest',
      }),
    );
    expect(await getPendingCount()).toBe(0);
  });

  it('returns not-applied for an unknown id', async () => {
    const res = await acceptProposal('nope');
    expect(res.applied).toBe(false);
  });
});

describe('rejectProposal', () => {
  it('remembers the fingerprint and drops it from pending; next sweep will not re-propose', async () => {
    seedFacts(MIN_FACTS_FOR_SWEEP);
    await runHygieneSweep({ now: NOW });
    const [proposal] = await getPendingProposals();

    await rejectProposal(proposal.id);
    expect(await getPendingCount()).toBe(0);
    expect(JSON.parse(mockKv.get('hygiene_rejected_fingerprints')!)).toContain(proposal.id);

    // A forced re-sweep must NOT re-propose the rejected fingerprint.
    const res = await runHygieneSweep({ now: NOW + 10 * DAY, force: true });
    const pending = await getPendingProposals();
    expect(pending.find((p) => p.id === proposal.id)).toBeUndefined();
    expect(res.proposalCount).toBe(0);
  });
});
