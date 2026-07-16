// TaskManager task — wakes on silent-push to UNPACK inference results only.
// The inference gateway emits phase-1-done / phase-2-done pushes carrying the
// requestId; this task fetches and decrypts the results, persists them, and
// dispatches the local "X impactful articles" notification.
//
// No new inference cycles are kicked off here. Fresh syncs run only in the
// foreground (app-resume / pull-to-refresh / Process button) — iOS throttles
// silent-push wakes too aggressively for that to be reliable.

// Ensure Sentry is initialised before this task runs. iOS may resolve this
// module on a silent-push wake without ever loading app/_layout.tsx, so the
// init must be a side-effect of importing this file.
import '@/lib/sentry-init';
// Polyfill crypto.getRandomValues for the silent-push wake path, which iOS may
// resolve without loading app/_layout.tsx — must precede any @noble/* crypto
// usage (prepareE2EEContext / encryptContent run on this background path).
// The import is an idempotent side-effect, safe to load from both entry points.
import 'react-native-get-random-values';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import logger from '@/lib/logger';
import {
  runBackgroundCycle,
  type CycleReason,
} from './run-inference-handler';

export const INFERENCE_TASK = 'mera-inference-task';

let defined = false;

/** Walk the variable shapes expo-notifications uses for the task body. iOS
 *  delivers `body.data.notification.request.content.data`; Android can deliver
 *  `body.data.dataString` (JSON) or `body.data.data` directly. We try them all
 *  and fall back to scanning every string field in the object. The gateway's
 *  completion push carries `{ type: 'inference-done', requestId }`; the
 *  `requestId` routes `handlePush` to the exact batch that just completed. */
function extractPushData(
  body: unknown,
): { type?: string; requestId?: string } | undefined {
  const root = (body as { data?: unknown })?.data;
  if (!root || typeof root !== 'object') return undefined;
  const r = root as Record<string, unknown>;

  const notif = r.notification as
    | { request?: { content?: { data?: { type?: string; requestId?: string } } } }
    | undefined;
  const direct = notif?.request?.content?.data;
  if (direct && typeof direct === 'object') return direct;

  const inner = r.data;
  if (inner && typeof inner === 'object')
    return inner as { type?: string; requestId?: string };

  if (typeof r.dataString === 'string') {
    try {
      return JSON.parse(r.dataString);
    } catch {
      /* ignore */
    }
  }

  if (typeof r.type === 'string' || typeof r.requestId === 'string') {
    return {
      type: typeof r.type === 'string' ? r.type : undefined,
      requestId: typeof r.requestId === 'string' ? r.requestId : undefined,
    };
  }
  return undefined;
}

function reasonForPushType(type: unknown): CycleReason {
  switch (type) {
    case 'phase1-done':
      return 'phase1-done';
    case 'phase2-done':
      return 'phase2-done';
    case 'inference-done':
    case 'process-clusters':
    default:
      return 'silent-push';
  }
}

/** Define the TaskManager task at module-load time so silent-push registration
 *  can reference the same task name. */
export function defineInferenceTask(): void {
  if (defined) return;
  defined = true;

  TaskManager.defineTask(INFERENCE_TASK, async (body) => {
    try {
      // expo-notifications registerTaskAsync delivers the push payload in
      // body.data.notification.request.content.data. Fall back to 'silent-push'
      // if the shape is anything else.
      const data = extractPushData(body);
      const reason = reasonForPushType(data?.type);
      // The gateway attaches the completed job's requestId; pass it through so
      // handlePush advances that exact batch (≤1 GET + ≤1 POST per wake).
      await runBackgroundCycle(reason, data?.requestId);
    } catch (err) {
      logger.captureException(err, {
        tags: { service: 'inference-task' },
      });
    }
  });
}

/** Wire silent push wakes to the task. Called at app boot. */
export async function ensureSilentPushTaskRegistered(): Promise<void> {
  defineInferenceTask();
  try {
    await Notifications.registerTaskAsync(INFERENCE_TASK);
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'inference-task', step: 'register-push' },
    });
  }
}
