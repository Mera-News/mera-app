// scoring-pipeline background entry points (the OS task): advanceWaitingForBackground (step a),
// submitScoringForBackground (step b), the stale-run verdict's run lookup, and the rule that a task
// step skips UI work while the app is not on screen. Real pipeline, DB, stores, limiter and gateway
// mock; the task's window is the real `deadlineAt` arithmetic on the fake clock.
//
// The limiter spaces every gateway action 1s apart in fake time, which the fake clock pays 1:1 in
// wall time, so a step that touches three batches takes seconds: the file raises the test timeout.
// A slow download is a results GET that moves the clock (`slowResults`), the way a real one eats the
// window.
import logger from '@/lib/logger';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { http, HttpResponse, server } from '@/test/helpers';
import {
  cleanupWorld,
  drive,
  gateway,
  resetPipelineWorld,
  seedArticles,
} from './scoring-pipeline-kit';

jest.setTimeout(60_000);
// Hoisted above the imports by babel-jest; written here so the imports stay first.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

const { submitScoringForBackground } = pipeline;
const DEADLINE_MS = 60_000;
const deadline = (ms = DEADLINE_MS) => Date.now() + ms;

beforeEach(() => resetPipelineWorld());
afterEach(cleanupWorld);

describe('submitScoringForBackground (step b)', () => {
  it('a 5xx attestation (MERA-APP-8W) stops the step with a breadcrumb and the one lane-exhausted event (the next run retries)', async () => {
    gateway({}, { pendingPolls: 999 });
    await seedArticles(['n0']);
    server.use(http.get('*/api/attestation/report', () => new HttpResponse('Upstream request failed', { status: 502 })));

    const out = await drive(submitScoringForBackground({ deadlineAt: deadline(), articleIds: ['n0'] }));

    expect(out.stoppedBy).toBe('error');
    // Chain exhausted (route1): the router's single content-free event, nothing about the attestation itself.
    expect(logger.captureException).toHaveBeenCalledTimes(1);
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'LaneExhaustedError' }),
      expect.objectContaining({ fingerprint: ['lane-exhausted', 'scoring'] }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('bg-submit'),
      expect.objectContaining({ statusCode: 502 }),
    );
  });
});
