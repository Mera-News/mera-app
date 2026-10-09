// CH7: Stop pressed before the on-device model produced its first token.
//
// The engine reads its stop flag between tokens (useLocalLLM's token loop) and the toolkit halts
// llama only once the consumer leaves the generator, so a Stop during prompt evaluation does
// nothing until a token arrives. On a cold low-end phone that wait is seconds of a Stop button that
// does not stop. The engine contract (lib/chat-session/engine.ts) is "abort the turn in flight".
import { stopChatTurn } from '@/lib/chat-session/chat-session';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import '@/test/helpers';
import {
  installLlama,
  llamaCalls,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
  until,
} from '@/test/integration/chat/_helpers';
import { attachLocal, expectNothingLeftTheDevice, local, settle, turnDone } from './kit';

jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

jest.setTimeout(30_000);

// The first token takes FIRST_TOKEN_MS of real time: the prompt-evaluation window.
const FIRST_TOKEN_MS = 2_000;

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await setProcessingMode('on-device');
  installLlama({ tokens: ['Never', ' shown.'], tokenDelayMs: FIRST_TOKEN_MS });
});

afterEach(async () => {
  await turnDone(10_000).catch(() => undefined);
  await settle();
  await inferenceQueue.stop();
});

async function stopBeforeFirstToken(): Promise<number> {
  const { engine } = await attachLocal();
  engine.send('hi');
  await until(() => llamaCalls().length === 1, 5_000, 'completion started');
  const stoppedAt = Date.now();
  stopChatTurn();
  return stoppedAt;
}

test.failing('Stop before the first token ends the turn without waiting for a token', async () => {
  const stoppedAt = await stopBeforeFirstToken();

  await until(() => !local().turnBusy, FIRST_TOKEN_MS / 2, 'turn end within half the first-token wait');
  expect(Date.now() - stoppedAt).toBeLessThan(FIRST_TOKEN_MS / 2);
  expect(llamaCalls()[0].stopped).toBe(true);
  expect(llamaCalls()[0].delivered).toEqual([]);
  expectNothingLeftTheDevice();
});

it('CH7 today: Stop before the first token waits for that token, then ends the turn', async () => {
  const stoppedAt = await stopBeforeFirstToken();

  await new Promise((r) => setTimeout(r, FIRST_TOKEN_MS / 2));
  expect(local().turnBusy).toBe(true);

  await turnDone(10_000);
  expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(FIRST_TOKEN_MS - 100);
  // The token loop saw the flag on the first token and left; llama was halted after it.
  expect(llamaCalls()[0].delivered).toEqual(['Never']);
  expect(llamaCalls()[0].stopped).toBe(true);
  const last = local().messages.filter((m) => m.role === 'assistant').at(-1);
  expect(last?.content ?? '').toBe('');
  expectNothingLeftTheDevice();
});
