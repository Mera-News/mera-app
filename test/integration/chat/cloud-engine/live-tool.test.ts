// The live tool row and the strip's phone work, through the real cloud engine: a real persona turn
// (the loop and the device port), the gateway mock (real E2EE both ways)
// and GraphQL held open in MSW, so the store is sampled while the tool genuinely runs.
import { BIG_MODEL } from '@/lib/llm/constants';
import { useChatPhaseStore, type LiveTool } from '@/lib/llm/chat-phase-store';
import { mockGateway, mockGql, server, signInFixtureAccount } from '@/test/helpers';
import { reply, resetChatModules, toolCall, until } from '@/test/integration/chat/_helpers';
import { attachCloud, personaAgent, settle, turnDone } from './kit';

jest.setTimeout(60_000);

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});

const phase = () => useChatPhaseStore.getState();

/** Answers `operation` with `data`, but only once released. */
function hold(operation: string, data: unknown) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let reached = false;
  server.use(
    mockGql(operation, async () => {
      reached = true;
      await held;
      return data;
    }),
  );
  return { release: () => release(), reached: () => reached };
}

describe('persona turn: the tool the phone runs is the live row', () => {
  it('a held place lookup is the live place tool with deviceWork, and is over before the next model call', async () => {
    const place = hold('PlaceSearch', { placeSearch: [] });
    const atNextCall: { liveTool: LiveTool | null; deviceWork: boolean }[] = [];
    server.use(...mockGateway((c) => {
      if (c.index === 0) return reply('One moment.', toolCall('load_skill', { id: 'facts/residence' }));
      if (c.index === 1) return reply('', toolCall('lookup_place', { query: 'Porto' }));
      atNextCall.push({ liveTool: phase().liveTool, deviceWork: phase().deviceWork });
      return 'Which part of Porto do you live in?';
    }));
    const { engine } = await attachCloud(personaAgent());

    engine.send('I live in Porto');
    await until(place.reached, 30_000, 'place lookup on the wire');

    expect(phase().liveTool).toEqual({ kind: 'place', toolName: 'lookup_place', args: { query: 'Porto' } });
    expect(phase().deviceWork).toBe(true);

    place.release();
    await turnDone();

    expect(atNextCall.length).toBeGreaterThan(0);
    expect(atNextCall[0]).toEqual({ liveTool: null, deviceWork: false });
    expect(phase().liveTool).toBeNull();
    expect(phase().deviceWork).toBe(false);
  });

  it('a retried call marks the turn, and the next send clears the mark', async () => {
    const decrypt400 = { status: 400, body: { error: `Provider failed for model '${BIG_MODEL}': Decryption failed` } };
    const retriedAtFirstCall: boolean[] = [];
    let turn = 0;
    server.use(...mockGateway((c) => {
      if (c.index === 0) return decrypt400;
      if (turn === 2 && retriedAtFirstCall.length === 0) retriedAtFirstCall.push(phase().retriedThisTurn);
      return 'Noted.';
    }));
    const { engine } = await attachCloud(personaAgent());

    turn = 1;
    engine.send('hello');
    await turnDone();
    expect(phase().retriedThisTurn).toBe(true);

    turn = 2;
    engine.send('hello again');
    await turnDone();
    expect(retriedAtFirstCall).toEqual([false]);
    expect(phase().retriedThisTurn).toBe(false);
  });
});

describe('persona turn: searchNews from the Mera button', () => {
  it('a held searchNews is a live row with deviceWork, and clears after', async () => {
    const news = hold('SearchNews', { searchNews: [] });
    server.use(...mockGateway((c) => {
      if (c.index === 0) return reply('One moment.', toolCall('load_skill', { id: 'conversation/follow-story' }));
      if (c.index === 1) return reply('', toolCall('searchNews', { query: 'Sporting CP' }));
      return 'Nothing new on that yet.';
    }));
    const { engine } = await attachCloud(personaAgent());

    engine.send('follow Sporting CP');
    await until(news.reached, 30_000, 'searchNews on the wire');

    expect(phase().liveTool).toEqual({ kind: 'working', toolName: 'searchNews', args: { query: 'Sporting CP' } });
    expect(phase().deviceWork).toBe(true);

    news.release();
    await turnDone();

    expect(phase().deviceWork).toBe(false);
  });
});
