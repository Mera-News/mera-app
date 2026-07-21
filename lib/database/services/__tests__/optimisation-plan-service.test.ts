// optimisation-plan-service unit tests — cycle guards, LLM-failure fallback,
// accept/dismiss routing, stale sweep, and plan replacement. Every underlying
// service is mocked; the pure digest analyzer runs for real so the wiring is
// exercised end-to-end.

const mockKv = new Map<string, string>();

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(() => 'evt'), warn: jest.fn(), info: jest.fn() },
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
    if (v === '') mockKv.delete(k);
    else mockKv.set(k, v);
  }),
}));

jest.mock('../article-feedback-service', () => ({
  getUnprocessedFeedback: jest.fn(async () => []),
  countUnprocessedFeedback: jest.fn(async () => 0),
  markFeedbackProcessed: jest.fn(async () => {}),
}));

jest.mock('../topic-service', () => ({
  getAllTopicSnapshots: jest.fn(async () => []),
  getAllByNormalizedText: jest.fn(async () => []),
}));

jest.mock('../persona-action-executor', () => ({
  applyPersonaAction: jest.fn(async () => ({ applied: true, summary: 'ok' })),
}));

jest.mock('../../../llm/cloudComplete', () => ({
  cloudComplete: jest.fn(async () => {
    throw new Error('gateway down');
  }),
}));

import {
  runOptimisationCycle,
  getPendingPlan,
  acceptPlan,
  dismissPlan,
  MIN_UNPROCESSED_FOR_RUN,
  RUN_COOLDOWN_MS,
} from '../optimisation-plan-service';
import * as feedbackService from '../article-feedback-service';
import * as executor from '../persona-action-executor';
import { toastManager } from '@/lib/toast-manager';
import { cloudComplete } from '../../../llm/cloudComplete';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface Row {
  id: string;
  sentiment: 'like' | 'dislike';
  title: string;
  createdAt: Date;
  contextJson: string | null;
}

function row(
  id: string,
  sentiment: 'like' | 'dislike',
  ctx: Record<string, unknown>,
  ageDays = 1,
): Row {
  return {
    id,
    sentiment,
    title: ctx.title as string ?? `story ${id}`,
    createdAt: new Date(NOW - ageDays * DAY),
    contextJson: JSON.stringify(ctx),
  };
}

function seed(rows: Row[]) {
  (feedbackService.getUnprocessedFeedback as jest.Mock).mockResolvedValue(rows);
  (feedbackService.countUnprocessedFeedback as jest.Mock).mockResolvedValue(rows.length);
}

/** Two auto (topic_up t1, t2) + one review (suppress evt obituary). */
function seedActionable() {
  seed([
    row('ra', 'like', { matchedTopics: [{ topicId: 't1', text: 'Climate' }], treePath: ['more_about_topic', 'a_lot_more'] }),
    row('rb', 'dislike', { eventType: 'obituary', treePath: ['not_important_to_me', 'this_kind_of_event'] }),
    row('rc', 'like', { matchedTopics: [{ topicId: 't2', text: 'Space' }], treePath: ['more_about_topic', 'a_lot_more'] }),
  ]);
}

beforeEach(() => {
  mockKv.clear();
  jest.clearAllMocks();
  (feedbackService.getUnprocessedFeedback as jest.Mock).mockResolvedValue([]);
  (feedbackService.countUnprocessedFeedback as jest.Mock).mockResolvedValue(0);
  (executor.applyPersonaAction as jest.Mock).mockResolvedValue({ applied: true, summary: 'ok' });
  (cloudComplete as jest.Mock).mockRejectedValue(new Error('gateway down'));
});

describe('runOptimisationCycle — guards', () => {
  it('skips when there are too few unprocessed signals', async () => {
    (feedbackService.countUnprocessedFeedback as jest.Mock).mockResolvedValue(MIN_UNPROCESSED_FOR_RUN - 1);
    const res = await runOptimisationCycle({ now: NOW });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('too_few_signals');
  });

  it('skips on cooldown when a recent run stamp exists', async () => {
    mockKv.set('optimisation_last_run_at', String(NOW - 60 * 60 * 1000)); // 1h ago < 20h
    seedActionable();
    const res = await runOptimisationCycle({ now: NOW });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('cooldown');
  });

  it('runs when cooldown has elapsed', async () => {
    mockKv.set('optimisation_last_run_at', String(NOW - RUN_COOLDOWN_MS - DAY));
    seedActionable();
    const res = await runOptimisationCycle({ now: NOW });
    expect(res.ran).toBe(true);
  });
});

describe('runOptimisationCycle — plan build (LLM-failure fallback)', () => {
  it('builds a deterministic plan and fires ONE notification when the gateway fails', async () => {
    seedActionable();
    const res = await runOptimisationCycle({ now: NOW });
    expect(res.ran).toBe(true);
    expect(cloudComplete).toHaveBeenCalledTimes(1); // attempted, then fell back
    expect(res.autoCount).toBe(2);
    expect(res.reviewCount).toBe(1);

    const plan = await getPendingPlan();
    expect(plan).not.toBeNull();
    expect(plan!.autoChanges.map((a) => a.fingerprint).sort()).toEqual(['topic_up:t1', 'topic_up:t2']);
    expect(plan!.reviewItems[0].fingerprint).toBe('suppress:evt:obituary');
    // Generic apply/skip options + default apply.
    expect(plan!.reviewItems[0].options.map((o) => o.action)).toEqual(['apply', 'skip']);

    expect(toastManager.showNotifiedToast).toHaveBeenCalledTimes(1);
    const arg = (toastManager.showNotifiedToast as jest.Mock).mock.calls[0][0];
    expect(arg.type).toBe('optimisation_plan');
    expect(arg.actions).toEqual([{ id: 'review-plan', labelKey: 'optimisationPlan.reviewChip' }]);
    expect(arg.context).toEqual({ count: 3 });

    // Run stamp written.
    expect(mockKv.get('optimisation_last_run_at')).toBe(String(NOW));
  });

  it('honours a valid LLM organization (moving a safe nudge to review)', async () => {
    seedActionable();
    (cloudComplete as jest.Mock).mockResolvedValueOnce(
      JSON.stringify({
        autoChanges: [{ fingerprint: 'topic_up:t2', summary: 'More Space' }],
        reviewItems: [
          {
            fingerprint: 'topic_up:t1',
            question: 'More about Climate?',
            options: [{ label: 'Yes', action: 'apply' }, { label: 'No', action: 'skip' }],
            defaultIndex: 0,
            rationale: 'You liked several climate stories.',
          },
          {
            fingerprint: 'suppress:evt:obituary',
            question: 'Fewer obituaries?',
            options: [{ label: 'Yes', action: 'apply' }, { label: 'No', action: 'skip' }],
            defaultIndex: 1,
            rationale: '',
          },
        ],
      }),
    );
    const res = await runOptimisationCycle({ now: NOW });
    expect(res.autoCount).toBe(1); // t2 stayed auto
    expect(res.reviewCount).toBe(2); // t1 promoted to review + the suppression
    const plan = await getPendingPlan();
    const climate = plan!.reviewItems.find((r) => r.fingerprint === 'topic_up:t1');
    expect(climate?.question).toBe('More about Climate?');
  });
});

describe('runOptimisationCycle — stale sweep', () => {
  it('marks long-stale signals processed when nothing is actionable', async () => {
    // Three lone dislikes with distinct event-types (no aggregate), 40 days old.
    seed([
      row('r1', 'dislike', { eventType: 'a' }, 40),
      row('r2', 'dislike', { eventType: 'b' }, 40),
      row('r3', 'dislike', { eventType: 'c' }, 40),
    ]);
    const res = await runOptimisationCycle({ now: NOW });
    expect(res.ran).toBe(true);
    expect(res.reason).toBe('no_candidates');
    expect(feedbackService.markFeedbackProcessed).toHaveBeenCalledWith(['r1', 'r2', 'r3']);
    expect(toastManager.showNotifiedToast).not.toHaveBeenCalled();
    expect(await getPendingPlan()).toBeNull();
  });

  it('does NOT sweep recent signals when nothing is actionable', async () => {
    seed([
      row('r1', 'dislike', { eventType: 'a' }, 1),
      row('r2', 'dislike', { eventType: 'b' }, 1),
      row('r3', 'dislike', { eventType: 'c' }, 1),
    ]);
    const res = await runOptimisationCycle({ now: NOW });
    expect(res.reason).toBe('no_candidates');
    expect(feedbackService.markFeedbackProcessed).not.toHaveBeenCalled();
  });
});

describe('runOptimisationCycle — replaces a prior pending plan', () => {
  it('overwrites the previous plan on a subsequent run', async () => {
    seedActionable();
    await runOptimisationCycle({ now: NOW });
    const first = await getPendingPlan();
    expect(first!.createdAt).toBe(NOW);

    await runOptimisationCycle({ now: NOW + 2 * DAY, force: true });
    const second = await getPendingPlan();
    expect(second!.createdAt).toBe(NOW + 2 * DAY);
  });
});

describe('acceptPlan', () => {
  it('applies all checked auto + selected review ops and marks ALL rows processed', async () => {
    seedActionable();
    await runOptimisationCycle({ now: NOW });

    const res = await acceptPlan();
    expect(res.applied).toBe(true);
    expect(res.appliedOps).toBe(3); // 2 topic_up + 1 suppress (default apply)
    expect(executor.applyPersonaAction).toHaveBeenCalledTimes(3);
    expect(feedbackService.markFeedbackProcessed).toHaveBeenCalledWith(['ra', 'rb', 'rc']);

    // Plan settled → no longer pending.
    expect(await getPendingPlan()).toBeNull();
  });

  it('skips unchecked auto + review "skip" options and remembers their fingerprints', async () => {
    seedActionable();
    await runOptimisationCycle({ now: NOW });

    const res = await acceptPlan({
      uncheckedAuto: ['topic_up:t1'],
      reviewChoices: { 'suppress:evt:obituary': 1 }, // index 1 = skip
    });
    expect(res.appliedOps).toBe(1); // only topic_up:t2 applied
    const rejected = JSON.parse(mockKv.get('optimisation_rejected_fingerprints')!);
    expect(rejected).toEqual(expect.arrayContaining(['topic_up:t1', 'suppress:evt:obituary']));

    // A subsequent run must not re-propose the rejected fingerprints.
    seedActionable();
    await runOptimisationCycle({ now: NOW + 2 * DAY, force: true });
    const plan = await getPendingPlan();
    const fps = [
      ...plan!.autoChanges.map((a) => a.fingerprint),
      ...plan!.reviewItems.map((r) => r.fingerprint),
    ];
    expect(fps).not.toContain('topic_up:t1');
    expect(fps).not.toContain('suppress:evt:obituary');
  });

  it('returns not-applied when there is no pending plan', async () => {
    const res = await acceptPlan();
    expect(res.applied).toBe(false);
  });
});

describe('dismissPlan', () => {
  it('remembers all fingerprints, marks rows processed, and clears the plan', async () => {
    seedActionable();
    await runOptimisationCycle({ now: NOW });

    await dismissPlan();
    expect(feedbackService.markFeedbackProcessed).toHaveBeenCalledWith(['ra', 'rb', 'rc']);
    const rejected = JSON.parse(mockKv.get('optimisation_rejected_fingerprints')!);
    expect(rejected).toEqual(
      expect.arrayContaining(['topic_up:t1', 'topic_up:t2', 'suppress:evt:obituary']),
    );
    expect(await getPendingPlan()).toBeNull();
    expect(executor.applyPersonaAction).not.toHaveBeenCalled();
  });
});

export {};
