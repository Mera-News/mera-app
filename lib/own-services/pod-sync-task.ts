import type { TaskDefinition } from '@/lib/scheduler/scheduler-types';

import { syncPod } from './pod-runner';

// Replaces the feed-sync task while paired, so every trigger syncs with the server and reads nothing here.
export const podFeedSyncTask: TaskDefinition<unknown> = {
  name: 'feed-sync',
  displayName: 'Feed Sync',
  frequency: 5 * 60 * 1000,
  triggers: ['app-foreground', 'network-reconnect'],
  conditions: [{ type: 'network' }, { type: 'db-ready' }],
  timeout: 60_000,
  maxAttempts: 1,
  exclusive: true,
  handler: () => syncPod(),
};
