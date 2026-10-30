// story_names: a followed story's mustMatch names, written by a background job from the accepted
// label and search. Real handler; the cloud branch through the gateway mock, the on-device branch
// through the scripted built-in model. The writer is injected (the tracking layer owns the write).
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { enqueueStoryNamesJob, handleStoryNamesJob } from '@/lib/inference/handlers/story-names-handler';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { installLlama, resetFileSystem } from '@/test/integration/chat/_helpers';
import { cleanup, driveDone, prepare, setMode, watchBodies } from './kit';

jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

beforeEach(async () => {
  resetFileSystem();
  await disposeModel();
  useMeraProtocolStore.getState().setModelState('downloaded');
  installLlama([]);
  installOnDeviceLlm();
  await prepare();
});
afterEach(cleanup);

const reply = (text: string) => server.use(...mockGateway(() => text));
const STORY = { topicId: 't1', label: 'Named Summit City', search: 'Named Summit City conference news' };

describe('story_names', () => {
  it('cloud: one 128-token call, the label and search in the prompt, normalized names written', async () => {
    reply('{"mustMatch":[" Named Summit ","named summit","NamedSummit"]}');
    const bodies = watchBodies('/v1/chat/completions');
    const write = jest.fn(async () => true);

    const out = await driveDone(handleStoryNamesJob({ ...STORY, useCloud: true }, undefined, write));

    expect(out).toEqual({ ok: true, names: 2 });
    expect((await bodies.bodies())[0]).toMatchObject({ max_tokens: 128, temperature: 0.3 });
    expect(gatewayCalls('chat')[0].messages[1].content).toContain('Named Summit City conference news');
    expect(write).toHaveBeenCalledWith('t1', ['Named Summit', 'NamedSummit']);
  });

  it('on-device (and a cloud-queued job once the mode is on-device): the built-in model, zero gateway calls', async () => {
    await setMode('on-device');
    installOnDeviceLlm({ reply: '{"mustMatch":["Named Summit"]}' });
    const write = jest.fn(async () => true);

    await driveDone(handleStoryNamesJob({ ...STORY, useCloud: true }, undefined, write));

    expect(onDeviceLlmCalls()).toHaveLength(1);
    expect(gatewayCalls()).toHaveLength(0);
    expect(write).toHaveBeenCalledWith('t1', ['Named Summit']);
  });

  it('an empty answer writes nothing', async () => {
    reply('{"mustMatch":[]}');
    const write = jest.fn(async () => true);
    expect(await driveDone(handleStoryNamesJob({ ...STORY, useCloud: true }, undefined, write))).toEqual({ ok: true, names: 0 });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['garbage output', () => reply('sorry, I cannot help with that')],
    ['a refused call', () => server.use(...mockGateway(() => ({ status: 400, body: { error: 'nope' } })))],
  ])('%s writes nothing', async (_label, arrange) => {
    arrange();
    const write = jest.fn(async () => true);
    expect(await driveDone(handleStoryNamesJob({ ...STORY, useCloud: true }, undefined, write))).toEqual({ ok: false });
    expect(write).not.toHaveBeenCalled();
  });

  it('an invalid payload asks no model', async () => {
    const write = jest.fn(async () => true);
    expect(await handleStoryNamesJob({ topicId: '', label: 'x', search: 'x', useCloud: true }, undefined, write)).toEqual({ ok: false });
    expect(gatewayCalls()).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('the built-in model saying "busy" rethrows so the queue defers the job', async () => {
    await setMode('on-device');
    const busy = Object.assign(new Error('busy'), { code: 'ERR_AFM_BUSY' });
    jest.spyOn(require('@/lib/llm/completeLocal'), 'completeLocal').mockRejectedValueOnce(busy);
    await expect(handleStoryNamesJob(STORY, undefined, jest.fn())).rejects.toBe(busy);
  });

  it('enqueue is one pending job per topic', async () => {
    expect(await enqueueStoryNamesJob(STORY)).toBe(true);
    expect(await enqueueStoryNamesJob(STORY)).toBe(false);
    expect(await enqueueStoryNamesJob({ ...STORY, topicId: 't2' })).toBe(true);
  });
});
