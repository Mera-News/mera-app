import { pruneOldJobs } from '../scheduler-persistence';
import { AppScheduler } from '../AppScheduler';

AppScheduler.register({
  name: 'data-cleanup',
  displayName: 'Data Cleanup',
  frequency: 24 * 60 * 60 * 1000,
  triggers: [],
  conditions: [{ type: 'db-ready' }],
  timeout: 30_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async () => {
    await pruneOldJobs();
  },
});
