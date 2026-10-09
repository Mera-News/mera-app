// cycle-state-machine: recoverCycle() is the one entry the app-resume task calls before new work.
// It returns the real scoring pipeline's recover() answer and swallows a recover() failure as 'idle'.

import logger from '@/lib/logger';
import { recoverCycle } from '@/lib/services/cycle-state-machine';
import * as scoringPipeline from '@/lib/services/scoring-pipeline';
import { drive, gateway, resetPipelineWorld, seedAndEnqueue, warmAttestation } from './scoring-pipeline-kit';

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

beforeEach(() => resetPipelineWorld());

describe('recoverCycle', () => {
  it('delegates to the pipeline recover() and returns idle', async () => {
    const recover = jest.spyOn(scoringPipeline, 'recover');
    try {
      const result = await drive(recoverCycle());

      expect(recover).toHaveBeenCalledTimes(1);
      expect(result).toBe('idle');
    } finally {
      recover.mockRestore();
    }
  });

  it('returns running when the pipeline still has in-flight batches', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });

    const result = await drive(recoverCycle());

    expect(result).toBe('running');
  });

  it('swallows a recover() failure, logs it, and returns idle', async () => {
    const err = new Error('recover blew up');
    const recover = jest.spyOn(scoringPipeline, 'recover').mockRejectedValueOnce(err);
    try {
      const result = await drive(recoverCycle());

      expect(logger.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          tags: expect.objectContaining({ service: 'cycle-state-machine', method: 'recoverCycle' }),
        }),
      );
      expect(result).toBe('idle');
    } finally {
      recover.mockRestore();
    }
  });
});
