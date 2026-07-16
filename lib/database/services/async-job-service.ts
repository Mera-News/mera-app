// Settings-backed inference helpers — last-nudge tracker.
// Backed by the key/value `settings` table to avoid a schema migration.
//
// - `lastNudgeAt` gates the on-device hourly nudge so we don't spam the user.
//
// (The single-slot pending-job lock + 7-state cycle marker that used to live
// here were removed once the multi-batch scoring pipeline replaced the legacy
// async-job flow; the pipeline persists its own state in scoring-pipeline-store.)

import {
  getSetting,
  setSetting,
} from './setting-service';

const LAST_NUDGE_KEY = 'async_inference_last_nudge';

export async function getLastNudgeAt(): Promise<number | null> {
  const raw = await getSetting(LAST_NUDGE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function setLastNudgeAt(timestamp: number): Promise<void> {
  await setSetting(LAST_NUDGE_KEY, String(timestamp));
}
