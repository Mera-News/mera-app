// InferenceJob model — test the static metadata and writer methods.
// WatermelonDB decorators are mocked so we can import the class without native SQLite.

jest.mock('@nozbe/watermelondb', () => {
  class Model {
    static table = '';
    update = jest.fn(async (fn?: (r: any) => void) => { fn?.(this); return this; });
    destroyPermanently = jest.fn(async () => {});
  }
  return { Model };
});

// Decorator mocks — no-ops so the class body loads without errors.
jest.mock('@nozbe/watermelondb/decorators', () => ({
  field: () => () => {},
  json: () => () => {},
  date: () => () => {},
  writer: () => (_t: any, _k: string, desc: PropertyDescriptor) => desc,
}));

import InferenceJob from '../InferenceJob';

// Build a plain object shaped like an InferenceJob with direct properties,
// bound to a real InferenceJob instance so its prototype methods are available.
function makeJob(overrides: Partial<InferenceJob> = {}): InferenceJob {
  const job = Object.create(InferenceJob.prototype) as InferenceJob;
  // Attach update / destroyPermanently as jest fns (same as WatermelonDB mock)
  job.update = jest.fn(async (fn?: (r: any) => void) => {
    fn?.(job);
    return job;
  });
  job.destroyPermanently = jest.fn(async () => {});
  // Set fields directly (no decorator, no _raw)
  (job as any).status = 'pending';
  (job as any).attempts = 0;
  (job as any).maxAttempts = 3;
  (job as any).errorMessage = null;
  Object.assign(job, overrides);
  return job;
}

describe('InferenceJob model', () => {
  it('has the correct static table name', () => {
    expect(InferenceJob.table).toBe('inference_jobs');
  });

  describe('markRunning()', () => {
    it('sets status to running and increments attempts', async () => {
      const job = makeJob({ status: 'pending' as any, attempts: 0 as any });
      await job.markRunning();
      expect(job.update).toHaveBeenCalledTimes(1);
      expect((job as any).status).toBe('running');
      expect((job as any).attempts).toBe(1);
    });

    it('treats undefined attempts as 0', async () => {
      const job = makeJob();
      (job as any).attempts = undefined;
      await job.markRunning();
      expect((job as any).attempts).toBe(1);
    });

    it('increments from a non-zero value', async () => {
      const job = makeJob({ attempts: 2 as any });
      await job.markRunning();
      expect((job as any).attempts).toBe(3);
    });
  });

  describe('markDone()', () => {
    it('sets status to done and stores the result', async () => {
      const job = makeJob({ status: 'running' as any });
      const result = { topics: ['a', 'b'] };
      await job.markDone(result);
      expect(job.update).toHaveBeenCalledTimes(1);
      expect((job as any).status).toBe('done');
      expect((job as any).result).toEqual(result);
    });
  });

  describe('markFailed()', () => {
    it('destroys permanently when attempts >= maxAttempts', async () => {
      const job = makeJob({ attempts: 3 as any, maxAttempts: 3 as any });
      await job.markFailed('too many tries');
      expect(job.destroyPermanently).toHaveBeenCalledTimes(1);
      expect(job.update).not.toHaveBeenCalled();
    });

    it('resets to pending and sets errorMessage when attempts < maxAttempts', async () => {
      const job = makeJob({ attempts: 1 as any, maxAttempts: 3 as any });
      await job.markFailed('transient error');
      expect(job.update).toHaveBeenCalledTimes(1);
      expect((job as any).status).toBe('pending');
      expect((job as any).errorMessage).toBe('transient error');
    });

    it('does NOT destroy when attempts is exactly 1 less than maxAttempts', async () => {
      const job = makeJob({ attempts: 2 as any, maxAttempts: 3 as any });
      await job.markFailed('err');
      expect(job.destroyPermanently).not.toHaveBeenCalled();
      expect((job as any).status).toBe('pending');
    });
  });

  describe('markUnrunnable() — the rollback-loop guard', () => {
    it('counts an attempt, so an unknown job type cannot spin forever', async () => {
      // An OTA rollback leaves a job type this bundle has no handler for. It
      // never reaches markRunning, so without its own increment the attempt
      // count never moves and markFailed re-pends it on every loop, forever.
      const job = makeJob({ attempts: 0 as any, maxAttempts: 3 as any });
      await job.markUnrunnable('Unknown job type: topic_combo');
      expect((job as any).attempts).toBe(1);
      expect((job as any).status).toBe('pending');
      expect((job as any).errorMessage).toBe('Unknown job type: topic_combo');
      await job.markUnrunnable('again');
      await job.markUnrunnable('again');
      expect(job.destroyPermanently).toHaveBeenCalledTimes(1);
    });
  });

  describe('markDeferred()', () => {
    it('re-pends and gives back the attempt markRunning took', async () => {
      const job = makeJob({ status: 'running' as any, attempts: 2 as any });
      await job.markDeferred('offline');
      expect((job as any).status).toBe('pending');
      expect((job as any).attempts).toBe(1);
      expect((job as any).errorMessage).toBe('offline');
      expect(job.destroyPermanently).not.toHaveBeenCalled();
    });

    it('never drops attempts below zero', async () => {
      const job = makeJob({ status: 'running' as any, attempts: 0 as any });
      await job.markDeferred('offline');
      expect((job as any).attempts).toBe(0);
    });
  });
});
