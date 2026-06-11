// SchedulerJob model — test static metadata only (no writer methods).

jest.mock('@nozbe/watermelondb', () => {
  class Model {
    static table = '';
  }
  return { Model };
});

jest.mock('@nozbe/watermelondb/decorators', () => ({
  field: () => () => {},
}));

import SchedulerJob from '../SchedulerJob';

describe('SchedulerJob model', () => {
  it('has the correct static table name', () => {
    expect(SchedulerJob.table).toBe('scheduler_jobs');
  });

  it('is importable without errors', () => {
    expect(SchedulerJob).toBeDefined();
    expect(typeof SchedulerJob).toBe('function');
  });

  it('can be instantiated', () => {
    const j = new SchedulerJob();
    expect(j).toBeDefined();
    expect(j instanceof SchedulerJob).toBe(true);
  });
});
