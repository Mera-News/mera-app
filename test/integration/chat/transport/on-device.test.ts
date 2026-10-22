// On-device mode never reaches the cloud AI. The gate reads the real mera-protocol store and the
// persisted `mera_processing_mode` row (the real in-memory DB), and every cloud entry point refuses
// with OnDeviceModeError before building a request: no attestation fetch, no chat or batch call.
import * as settingService from '@/lib/database/services/setting-service';
import { setSetting } from '@/lib/database/services/setting-service';
import { prepareE2EEContext, rebuildE2EEContext } from '@/lib/e2ee/e2ee-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { cloudBatchComplete, cloudChatStream, cloudComplete } from '@/lib/llm/cloudComplete';
import {
  assertCloudAllowed,
  isOnDeviceMode,
  isOnDeviceModeError,
  OnDeviceModeError,
} from '@/lib/llm/on-device-gate';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { attestationRequests, gatewayCalls, mockGateway, server } from '@/test/helpers';
import {
  BATCH_PATH,
  CHAT_PATH,
  errorOf,
  fakeClock,
  resetTransport,
  respond,
  run,
  watchRequests,
} from './transport-kit';

const SENTINEL = 'SENTINEL-ONDEVICE-8c3b';
const ROW = 'mera_processing_mode';

const setStoreMode = (processingMode: ProcessingMode) => useMeraProtocolStore.setState({ processingMode });

let spies: jest.SpyInstance[] = [];

beforeEach(async () => {
  await resetTransport();
});

afterEach(() => {
  server.events.removeAllListeners();
  spies.forEach((s) => s.mockRestore());
  spies = [];
  setStoreMode(ProcessingMode.Cloud);
  useMeraProtocolStore.setState({ chatInCloud: false });
});

describe('isOnDeviceMode', () => {
  it('is false in cloud mode, and the setting is read once, not on every call', async () => {
    const read = jest.spyOn(settingService, 'getSetting');
    spies.push(read);

    expect(await isOnDeviceMode()).toBe(false);
    expect(await isOnDeviceMode()).toBe(false);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('is true when the store says on-device, without reading the setting', async () => {
    const read = jest.spyOn(settingService, 'getSetting');
    spies.push(read);
    setStoreMode(ProcessingMode.OnDevice);

    expect(await isOnDeviceMode()).toBe(true);

    expect(read).not.toHaveBeenCalled();
  });

  it('is true when the store is still on its Cloud default but the persisted mode is on-device (a background wake before hydration)', async () => {
    const read = jest.spyOn(settingService, 'getSetting');
    spies.push(read);
    await setSetting(ROW, ProcessingMode.OnDevice);
    read.mockClear();

    expect(await isOnDeviceMode()).toBe(true);
    // Never cached: the store may still be unhydrated on the next call.
    expect(await isOnDeviceMode()).toBe(true);

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('follows a later switch to on-device through the store', async () => {
    expect(await isOnDeviceMode()).toBe(false);
    setStoreMode(ProcessingMode.OnDevice);
    expect(await isOnDeviceMode()).toBe(true);
  });

  it('falls back to the store when the setting cannot be read', async () => {
    spies.push(jest.spyOn(settingService, 'getSetting').mockRejectedValue(new Error('db')));

    expect(await isOnDeviceMode()).toBe(false);

    setStoreMode(ProcessingMode.OnDevice);
    expect(await isOnDeviceMode()).toBe(true);
  });
});

describe('assertCloudAllowed', () => {
  it('passes in cloud mode', async () => {
    await expect(assertCloudAllowed()).resolves.toBeUndefined();
  });

  it('throws a typed error in on-device mode', async () => {
    setStoreMode(ProcessingMode.OnDevice);

    const err = await errorOf(assertCloudAllowed());

    expect(err).toBeInstanceOf(OnDeviceModeError);
    expect(isOnDeviceModeError(err)).toBe(true);
    expect(isOnDeviceModeError(new Error('other'))).toBe(false);
    expect(isOnDeviceModeError(null)).toBe(false);
  });
});

describe('every cloud entry point refuses in on-device mode', () => {
  const entryPoints: [string, () => Promise<unknown>][] = [
    ['cloudComplete', () => cloudComplete({ systemPrompt: SENTINEL, prompt: SENTINEL })],
    [
      'cloudBatchComplete',
      () => cloudBatchComplete([{ id: 'a', system: SENTINEL, prompt: SENTINEL, temperature: 0.3 }]),
    ],
    ['cloudChatStream', () => cloudChatStream({ messages: [{ role: 'user', content: SENTINEL }] }).next()],
    ['prepareE2EEContext', () => prepareE2EEContext(SMALL_MODEL)],
    ['rebuildE2EEContext', () => rebuildE2EEContext(SMALL_MODEL, 'ab'.repeat(32), 'ed25519')],
  ];
  const triggers: [string, () => Promise<void>][] = [
    ['the store says on-device', async () => setStoreMode(ProcessingMode.OnDevice)],
    [
      'only the persisted row says on-device (the store is still on its Cloud default)',
      () => setSetting(ROW, ProcessingMode.OnDevice),
    ],
  ];

  describe.each(triggers)('when %s', (_label, trigger) => {
    beforeEach(trigger);

    it.each(entryPoints)('%s throws OnDeviceModeError and nothing leaves the device', async (_name, call) => {
      const chat = watchRequests(CHAT_PATH);
      const batch = watchRequests(BATCH_PATH);

      const err = await errorOf(call());

      expect(err).toBeInstanceOf(OnDeviceModeError);
      expect(err?.name).toBe('OnDeviceModeError');
      expect(attestationRequests()).toBe(0);
      expect(chat.count()).toBe(0);
      expect(batch.count()).toBe(0);
      expect(gatewayCalls()).toEqual([]);
    });
  });

  it('the cloud-mode control goes through, sealed', async () => {
    fakeClock();
    server.use(...mockGateway(respond('from the cloud')));
    const chat = watchRequests(CHAT_PATH);

    const result = await run(cloudComplete({ systemPrompt: SENTINEL, prompt: SENTINEL }));

    expect(result).toBe('from the cloud');
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect((await chat.raw())[0]).not.toContain('SENTINEL');
  });
});

describe('cloud chat while on device: only chat calls pass', () => {
  beforeEach(() => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice, chatInCloud: true });
  });

  it('a chat stream and the quick-check completion reach the gateway', async () => {
    fakeClock();
    server.use(...mockGateway(respond('from the cloud')));

    const events: unknown[] = [];
    await run((async () => {
      for await (const e of cloudChatStream({ messages: [{ role: 'user', content: SENTINEL }] })) events.push(e);
    })());
    const quick = await run(cloudComplete({ systemPrompt: SENTINEL, prompt: SENTINEL, purpose: 'chat' }));

    expect(events).toContainEqual({ type: 'text-delta', delta: 'from the cloud' });
    expect(quick).toBe('from the cloud');
    expect(gatewayCalls('chat')).toHaveLength(2);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['a background cloudComplete', () => cloudComplete({ systemPrompt: SENTINEL, prompt: SENTINEL })],
    ['cloudBatchComplete', () => cloudBatchComplete([{ id: 'a', system: SENTINEL, prompt: SENTINEL, temperature: 0.3 }])],
    ['a background prepareE2EEContext', () => prepareE2EEContext(SMALL_MODEL)],
    ['rebuildE2EEContext', () => rebuildE2EEContext(SMALL_MODEL, 'ab'.repeat(32), 'ed25519')],
  ])('%s still throws OnDeviceModeError', async (_name, call) => {
    const err = await errorOf(call());

    expect(err).toBeInstanceOf(OnDeviceModeError);
    expect(attestationRequests()).toBe(0);
    expect(gatewayCalls()).toEqual([]);
  });

  it('with cloud chat off, a chat call throws as before', async () => {
    useMeraProtocolStore.setState({ chatInCloud: false });

    expect(await errorOf(assertCloudAllowed('chat'))).toBeInstanceOf(OnDeviceModeError);
  });
});
