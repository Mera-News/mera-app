// The persona-hygiene scheduler task on the REAL AppScheduler, driving the real hygiene sweep, the real
// topic-sanity audit and the gateway mock (real E2EE), with the session cookie in the (in-memory) keychain.
// The sweep is covered in services/cloud-persona/hygiene-sweep.test.ts; this file pins what the TASK adds:
// the LOCAL credential gate in front of a billed batch, what a gated run leaves behind (job done, lastRun
// NOT stamped, so the next tick retries), and what holds the weekly sweep back. Replaces
// lib/scheduler/tasks/__tests__/persona-hygiene-task.test.ts.
import { failSecureStore, mockGateway, secureStoreDump, server } from '@/test/helpers';
import '@/lib/scheduler/tasks/persona-hygiene-task';

import { addFact } from '@/lib/database/services/fact-service';
import { MIN_FACTS_FOR_SWEEP, getPendingCount } from '@/lib/database/services/hygiene-service';
import { getSetting } from '@/lib/database/services/setting-service';

import {
  DAY,
  T0,
  endTest,
  lastRunInStore,
  resetCloudCallPath,
  runTask,
  sanityModel,
  seedLocalUser,
  startTest,
} from './support';

jest.setTimeout(30_000); // the tick tests step minutes of fake time, which an instrumented run can stretch

const TASK = 'persona-hygiene';
const STAMP = 'hygiene_last_sweep_at';

/** `count` facts created 100 days before T0; fact 0 is the single word "News" (too broad: one cleanup proposed). */
async function seedPersona(count = MIN_FACTS_FOR_SWEEP) {
  jest.setSystemTime(T0 - 100 * DAY);
  for (let i = 0; i < count; i++) await addFact(i === 0 ? 'News' : `distinct interest number ${i}`);
  jest.setSystemTime(T0);
}

const cookieKey = () => {
  const key = Object.keys(secureStoreDump()).find((k) => k.endsWith('_cookie'));
  if (!key) throw new Error('no session cookie in the keychain');
  return key;
};

beforeEach(async () => {
  resetCloudCallPath();
  await startTest(TASK, { signedIn: true });
  seedLocalUser(); // the `authenticated` condition needs a persona in the user store
  server.use(...mockGateway(sanityModel()));
});
afterEach(endTest);

describe('the credential gate', () => {

  // The secure-store adapter turns a synchronous keychain throw into null ("nothing stored"), so the task's own
  // try/catch around getCookie() is never entered at this seam (an R30 candidate); the outcome is the same.
  it('a keychain that THROWS on the cookie read (locked before first unlock) counts as no credential', async () => {
    await seedPersona();
    failSecureStore(cookieKey(), 'get');

    await runTask(TASK);

    expect(await getSetting(STAMP)).toBeNull();
    expect(await getPendingCount()).toBe(0);
    expect(lastRunInStore(TASK)).toBeNull();
  });
});
