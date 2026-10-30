// "More options" on a follow card, on the phone: one built-in call, no Kev, no thread change.
import { attachLocal, local, tutorialAgent } from '@/test/integration/chat/local-engine/kit';
import { FollowStoryOnDeviceAgent } from '@/lib/llm/agents/on-device/FollowStoryOnDeviceAgent';
import { runMoreTrackOptions } from '@/lib/news-harness/on-device/follow-story/more-options';
import { FIXTURE_ACCOUNT } from '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { resetFileSystem, setProcessingMode } from '@/test/integration/chat/_helpers';
import { resetAgentWorld } from '@/test/integration/chat/tools/agents/agents-kit';

jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

const subject = { origin: 'article' as const, surface: 'detail', articleId: 'a1', title: 't' };
const shown = [
  { label: 'Bridge Repairs', searchText: 'Harbour bridge repairs' },
  { label: 'City Roadworks', searchText: 'City roadworks' },
];
const opt = (label: string, search: string) => ({ label, search });

function ports(value: unknown | Error) {
  const write = jest.fn(async () => {
    if (value instanceof Error) throw value;
    return value as Record<string, unknown>;
  });
  return { write, budget: async () => 2000 };
}
const run = (p: ReturnType<typeof ports>, room = 4) =>
  runMoreTrackOptions({ today: '2026-10-27', shown, room, subject }, p as never);

describe('runMoreTrackOptions', () => {
  it('drops options matching a shown label or searchText, or an earlier one, in any case and spacing', async () => {
    const p = ports({
      options: [
        opt('  bridge   repairs ', 'Something else'),
        opt('Fresh One', 'city  ROADWORKS'),
        opt('Fresh Two', 'Fresh two search'),
        opt('FRESH TWO', 'Another search'),
        opt('Fresh Three', 'fresh two SEARCH'),
        opt('Fresh Four', 'Fresh four search'),
      ],
    });
    const r = await run(p);
    expect(r.actions.map((a) => [a.label, a.subject])).toEqual([
      ['Fresh Two', subject],
      ['Fresh Four', subject],
    ]);
    expect(r.reason).toBeUndefined();
    expect(p.write).toHaveBeenCalledTimes(1);
  });

  it('returns at most room', async () => {
    const p = ports({ options: [opt('A One', 'a1'), opt('B Two', 'b2'), opt('C Three', 'c3')] });
    expect((await run(p, 2)).actions).toHaveLength(2);
  });

  it('answers none when nothing new is left', async () => {
    expect(await run(ports({ options: [] }))).toEqual({ actions: [], reason: 'none' });
    expect(await run(ports({ options: [opt('Bridge Repairs', 'x')] }))).toEqual({ actions: [], reason: 'none' });
  });

  it('carries each option\'s mustMatch names, normalized, and none when it has none', async () => {
    const p = ports({
      options: [
        { label: 'Fresh Summit', search: 'Fresh summit', mustMatch: [' Fresh Summit ', 'fresh summit', 'FS'] },
        opt('Fresh Broad', 'fresh broad'),
      ],
    });
    const r = await run(p);
    expect(r.actions[0].mustMatch).toEqual(['Fresh Summit']);
    expect('mustMatch' in r.actions[1]).toBe(false);
  });

  it('answers failed on a throwing writer', async () => {
    expect(await run(ports(new Error('boom')))).toEqual({ actions: [], reason: 'failed' });
  });
});

describe('the on-device engine', () => {
  beforeEach(async () => {
    resetFileSystem();
    await resetAgentWorld();
    await setProcessingMode('on-device');
    installOnDeviceLlm();
  });
  const req = { proposalId: 'p1', shown, room: 4, subject };

  it('runs one structured call, no decide, and adds nothing to the thread', async () => {
    installOnDeviceLlm({ reply: JSON.stringify({ options: [opt('Fresh Story', 'fresh story')] }) });
    const { engine } = await attachLocal(new FollowStoryOnDeviceAgent(FIXTURE_ACCOUNT.userId, { route: 'kev' }));
    const r = await engine.moreOptions!(req);
    expect(r.actions.map((a) => a.label)).toEqual(['Fresh Story']);
    expect(onDeviceLlmCalls()).toHaveLength(1);
    expect(local().messages).toHaveLength(0);
  });

  it('answers none for an agent without the method', async () => {
    const { engine } = await attachLocal(tutorialAgent());
    expect(await engine.moreOptions!(req)).toEqual({ actions: [], reason: 'none' });
  });

  it('discards the answer when Stop lands while it runs', async () => {
    installOnDeviceLlm({ reply: JSON.stringify({ options: [opt('Fresh Story', 'fresh story')] }) });
    const { engine } = await attachLocal(new FollowStoryOnDeviceAgent(FIXTURE_ACCOUNT.userId));
    const pending = engine.moreOptions!(req);
    engine.stop();
    expect(await pending).toEqual({ actions: [], reason: 'stopped' });
  });
});
