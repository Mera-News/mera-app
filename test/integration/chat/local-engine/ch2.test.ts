// CH2: the on-device engine accepts a send during the tool phase.
//
// `status` goes idle BEFORE the tool loop runs (the composer is released while tools work), but
// `turnBusy` is still true. The engine's own guard reads `isStreamingRef`, which is released at the
// same point as `status`, so a second send starts a second turn on top of the first turn's tools.
// Decided behaviour (DECISIONS.md, "Behaviour choices for P3 fixes"): refuse it, the same as
// during streaming.
//
// The tool is held by the real persona agent's executor behind a gate the test opens.
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { initBaseModel } from '@/lib/mera-protocol-toolkit';
import { signInFixtureAccount } from '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import {
  installLlama,
  resetChatModules,
  resetFileSystem,
  setProcessingMode,
  until,
} from '@/test/integration/chat/_helpers';
import { attachLocal, local, personaAgent, personaReply, saveFactReply, settle, streamHolds, turnDone } from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

jest.setTimeout(30_000);

let openGate: () => void;
let toolStarted: boolean;

afterEach(async () => {
  openGate();
  await settle();
  await inferenceQueue.stop();
});

beforeEach(async () => {
  resetChatModules();
  resetFileSystem();
  await signInFixtureAccount();
  await setProcessingMode('on-device');
  toolStarted = false;
  // Turn 1 offers a fact; every later completion is a plain reply.
  installLlama([]);
  installOnDeviceLlm({
    reply: (call) => (onDeviceLlmCalls().indexOf(call) === 0 ? saveFactReply() : personaReply({ reply: 'Second reply.' })),
  });
  await initBaseModel();
  await inferenceQueue.start();
});

/** Sends the first message and returns once its tool is in flight: status idle, turn busy. */
async function reachToolPhase() {
  const agent = personaAgent();
  const gate = new Promise<void>((r) => (openGate = r));
  const run = agent.executeTool.bind(agent);
  agent.executeTool = async (name, input) => {
    toolStarted = true;
    await gate;
    return run(name, input);
  };
  const session = await attachLocal(agent);
  session.engine.send('first');
  await until(() => toolStarted, 10_000, 'the tool in flight');
  expect(local()).toMatchObject({ status: 'idle', turnBusy: true });
  expect(local().messages.at(-1)?.toolCalls?.[0]).toMatchObject({ name: 'saveExtractedFacts', status: 'pending' });
  return session;
}

const userTexts = () => local().messages.filter((m) => m.role === 'user').map((m) => m.content);

describe('a send while the first turn runs its tools', () => {
  it('is refused, the same as during streaming', async () => {
    const { engine } = await reachToolPhase();

    engine.send('second');
    await new Promise((r) => setTimeout(r, 150));

    // Refused: no second completion, no second user message, and the turn is still busy.
    expect(onDeviceLlmCalls()).toHaveLength(1);
    expect(userTexts()).toEqual(['first']);
    expect(local().turnBusy).toBe(true);
    expect(streamHolds()).toBe(1);

    openGate();
    await turnDone();
    expect(onDeviceLlmCalls()).toHaveLength(1);
    expect(local().messages.find((m) => m.role === 'assistant')?.toolCalls?.[0].status).toBe('done');
  });
});
