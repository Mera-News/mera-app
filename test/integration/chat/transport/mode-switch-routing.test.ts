// Switching the Mera Protocol mode switches the profile set the NEXT request uses, both ways, with
// "chat in cloud" as the third state. The router, the chat engine choice and the gate all read the
// one store, so each is checked across a flip; a turn already in flight keeps the profile it began on.
import { BIG_MODEL } from '@/lib/llm/constants';
import { chatRunsInCloud } from '@/lib/llm/chat-cloud';
import { cloudChatStream, cloudComplete } from '@/lib/llm/cloudComplete';
import { isOnDeviceModeError } from '@/lib/llm/on-device-gate';
import { LANES, CHAT_LANES, routeLane, type Lane } from '@/lib/llm/router';
import { PROFILES } from '@/lib/llm/profiles';
import { attestProfile } from '@/lib/llm/provider-e2ee';
import { setProcessingMode, useStrictClock } from '@/test/integration/chat/_helpers';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import {
  collect,
  drive,
  installChatHooks,
  MESSAGES,
  textOf,
} from '@/test/integration/chat/streaming/support';

installChatHooks();

afterEach(async () => {
  await setProcessingMode('cloud');
});

const ids = (lane: Lane) => routeLane(lane).map((p) => p.id);
const cloudLanes = LANES.filter((l) => !CHAT_LANES.includes(l));

describe('routeLane across a mode switch', () => {
  it('Cloud -> On this phone: every cloud lane routes nothing', async () => {
    await setProcessingMode('cloud');
    for (const lane of LANES) expect(ids(lane).length).toBeGreaterThan(0);
    expect(chatRunsInCloud()).toBe(true);

    await setProcessingMode('on-device');
    for (const lane of LANES) expect(ids(lane)).toEqual([]);
    expect(chatRunsInCloud()).toBe(false);
  });

  it('On this phone + chat in cloud: chat lanes route to cloud profiles, every other lane does not', async () => {
    await setProcessingMode('on-device+cloud-chat');
    for (const lane of CHAT_LANES) expect(ids(lane).length).toBeGreaterThan(0);
    for (const lane of cloudLanes) expect(ids(lane)).toEqual([]);
    expect(chatRunsInCloud()).toBe(true);
  });

  it('On this phone -> Cloud: cloud profiles return for every lane on the next request', async () => {
    await setProcessingMode('on-device');
    for (const lane of LANES) expect(ids(lane)).toEqual([]);

    await setProcessingMode('cloud');
    for (const lane of LANES) expect(ids(lane).length).toBeGreaterThan(0);
    expect(chatRunsInCloud()).toBe(true);
  });

  it('turning chat in cloud off while On this phone takes the chat lanes away again', async () => {
    await setProcessingMode('on-device+cloud-chat');
    expect(ids('chat-tools').length).toBeGreaterThan(0);
    await setProcessingMode('on-device');
    for (const lane of CHAT_LANES) expect(ids(lane)).toEqual([]);
    expect(chatRunsInCloud()).toBe(false);
  });
});

describe('the gateway follows the mode on the next request', () => {
  it('a chat call after Cloud -> On this phone never reaches the gateway; after chat in cloud it does', async () => {
    server.use(...mockGateway(() => 'hello'));
    await setProcessingMode('on-device');
    const refused = await collect(cloudChatStream({ messages: MESSAGES, route: 'chat-tools' })).catch((e) => e);
    expect(isOnDeviceModeError(refused)).toBe(true);
    expect(gatewayCalls('chat')).toHaveLength(0);

    await setProcessingMode('on-device+cloud-chat');
    expect(textOf(await collect(cloudChatStream({ messages: MESSAGES, route: 'chat-tools' })))).toBe('hello');
    expect(gatewayCalls('chat')).toHaveLength(1);
  });

  it('with chat in cloud, a background-lane completion is still refused', async () => {
    server.use(...mockGateway(() => 'hello'));
    await setProcessingMode('on-device+cloud-chat');
    const refused = await cloudComplete({ systemPrompt: 's', prompt: 'p', route: 'background' }).catch((e) => e);
    expect(isOnDeviceModeError(refused)).toBe(true);
    expect(gatewayCalls('chat')).toHaveLength(0);
  });

  it('On this phone -> Cloud: a background-lane completion goes to the gateway on the next request', async () => {
    server.use(...mockGateway(() => 'ok'));
    await setProcessingMode('on-device');
    expect(isOnDeviceModeError(await cloudComplete({ systemPrompt: 's', prompt: 'p', route: 'background' }).catch((e) => e))).toBe(true);
    await setProcessingMode('cloud');
    expect(await cloudComplete({ systemPrompt: 's', prompt: 'p', route: 'background' })).toBe('ok');
    expect(gatewayCalls('chat')).toHaveLength(1);
  });

  it('a turn in flight during a switch finishes on its original profile', async () => {
    useStrictClock('2026-11-10T00:00:00Z');
    await drive(attestProfile(PROFILES['near/qwen3.8-27b']));
    server.use(...mockGateway(() => ({ chunks: ['one ', 'two ', 'three'], chunkDelayMs: 500 })));

    const events = collect(cloudChatStream({ messages: MESSAGES, route: 'chat-tools' }));
    await drive(Promise.resolve().then(async () => {
      while (gatewayCalls('chat').length < 1) await jest.advanceTimersByTimeAsync(50);
    }));
    await setProcessingMode('on-device'); // the reader flips the mode mid-stream
    await drive(events);

    expect(textOf(await events)).toBe('one two three');
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([BIG_MODEL]);
  });
});
