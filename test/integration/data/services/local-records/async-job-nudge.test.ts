// async-job-service: the settings-backed last-nudge timestamp. Both exports have no production
// caller (P4 dead-code candidates), so every test is tagged. Replaces
// lib/database/services/__tests__/async-job-service.test.ts, which mocked the settings service;
// this one runs on the real settings table.
import { getLastNudgeAt, setLastNudgeAt } from '@/lib/database/services/async-job-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

const KEY = 'async_inference_last_nudge';

describe('async-job-service', () => {
  it('[dead-candidate] getLastNudgeAt is null when no nudge was recorded', async () => {
    expect(await getLastNudgeAt()).toBeNull();
  });

  it('[dead-candidate] setLastNudgeAt stores the timestamp as a string under the nudge key, and getLastNudgeAt reads it back as a number', async () => {
    await setLastNudgeAt(1700000000000);

    expect(await getSetting(KEY)).toBe('1700000000000');
    expect(await getLastNudgeAt()).toBe(1700000000000);
  });

  it('[dead-candidate] a later nudge replaces the earlier one', async () => {
    await setLastNudgeAt(1700000000000);
    await setLastNudgeAt(1700000999999);
    expect(await getLastNudgeAt()).toBe(1700000999999);
  });

  it('[dead-candidate] getLastNudgeAt is null for a stored value that is not a finite number', async () => {
    await setSetting(KEY, 'not-a-number');
    expect(await getLastNudgeAt()).toBeNull();
    await setSetting(KEY, 'Infinity');
    expect(await getLastNudgeAt()).toBeNull();
  });
});
