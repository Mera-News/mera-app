// A batch item whose choice carries no message at all settles as an empty output, not a crash,
// and its siblings still decrypt.
import { cloudBatchComplete } from '@/lib/llm/cloudComplete';
import type { BatchCall } from '@/lib/llm/types';
import { signInFixtureAccount } from '@/test/helpers';
import { BATCH_PATH, fakeClock, resetTransport, run, serveJson } from './transport-kit';

const call = (id: string): BatchCall => ({ id, system: `system-${id}`, prompt: `prompt-${id}`, temperature: 0.3 });

beforeEach(async () => {
  await resetTransport({ signIn: false });
  await signInFixtureAccount();
  fakeClock();
});

it('maps an item with no message to an empty output with no error', async () => {
  serveJson(BATCH_PATH, (seal) => ({
    results: [
      { index: 0, response: { choices: [{ finish_reason: 'stop' }] } },
      { index: 1, response: { choices: [{ message: { content: seal('sibling-ok') }, finish_reason: 'stop' }] } },
    ],
  }));

  const out = await run(cloudBatchComplete([call('a'), call('b')]));

  expect(out).toEqual([
    { id: 'a', output: '' },
    { id: 'b', output: 'sibling-ok' },
  ]);
  expect(out[0]).not.toHaveProperty('error');
});
