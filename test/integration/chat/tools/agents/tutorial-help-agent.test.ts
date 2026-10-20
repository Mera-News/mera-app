// TutorialHelpAgent: the "Ask Mera" agent on a tutorial slide. Real stores, real web-search handler
// against the gateway mock, real database. The point of the class is still what it does NOT have:
// nothing that can change the reader's profile.
import { TutorialHelpAgent } from '@/lib/llm/agents/TutorialHelpAgent';
import { gatewayCalls, server } from '@/test/helpers';
import { setWebSearchInChat } from '@/test/integration/chat/_helpers';
import { factStatements, queuedJobs, resetAgentWorld, setLanguage, spyWarn, toolNames } from './agents-kit';

jest.setTimeout(30_000);

beforeEach(async () => {
  await resetAgentWorld();
  await setWebSearchInChat(true);
});
afterEach(() => server.events.removeAllListeners());

describe('TutorialHelpAgent', () => {
  it('scopes its conversation id to the user', () => {
    expect(new TutorialHelpAgent('u1', null).id).toBe('tutorial-help-u1');
  });

  // THE POINT OF THE CLASS: `webSearch` is read-only. Every tool that could MUTATE the reader's
  // profile or settings must stay absent.
  it('offers webSearch and nothing that can change anything', () => {
    const agent = new TutorialHelpAgent('u1', 'tutorials/privacy/what-leaves');
    expect(toolNames(agent)).toEqual(['webSearch']);
  });

  it('offers NO tools at all when the user has web search off', async () => {
    await setWebSearchInChat(false);
    expect(new TutorialHelpAgent('u1', null).getToolDefinitions()).toEqual([]);
  });

  it('executes webSearch instead of refusing it: the query reaches the search route', async () => {
    const agent = new TutorialHelpAgent('u1', null);

    const out = await agent.executeTool('webSearch', { queries: ['who won'] });

    expect(gatewayCalls('web-search').map((c) => c.messages[0].content)).toEqual(['who won']);
    expect(out.result).toMatchObject({ searched: true });
  });

  it('a webSearch call replayed after the toggle went off is refused and sends nothing', async () => {
    const agent = new TutorialHelpAgent('u1', null);
    await setWebSearchInChat(false);

    const out = await agent.executeTool('webSearch', { queries: ['who won'] });

    expect(out.result).toMatchObject({ searched: false });
    expect(gatewayCalls('web-search')).toEqual([]);
  });

  it('refuses an invented tool call instead of throwing, and writes nothing to the profile', async () => {
    const warn = spyWarn();
    const agent = new TutorialHelpAgent('u1', null);

    const result = await agent.executeTool('saveExtractedFacts', { extracted_user_information: ['Lives in Porto'] });

    expect(result.result).toMatchObject({ error: expect.any(String) });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[TutorialHelpAgent]'), expect.anything());
    // Crucially: no side effects reported, so nothing downstream applies it...
    expect(result.sideEffects).toBeUndefined();
    // ...and nothing was written behind the reader's back.
    expect(await factStatements()).toEqual([]);
    expect(await queuedJobs()).toEqual([]);
    warn.mockRestore();
  });

  it('seeds its context from the slide the reader is on', async () => {
    const agent = new TutorialHelpAgent('u1', 'tutorials/sources/the-two-badges');
    const context = await agent.buildContext();

    expect(context).toContain('sources');
    expect(context).toContain('the-two-badges');
  });

  it('still produces a context with no route', async () => {
    const context = await new TutorialHelpAgent('u1', null).buildContext();
    expect(context).toContain('<context>');
  });

  it('builds a prompt in the app language', async () => {
    setLanguage('nl');
    const prompt = await new TutorialHelpAgent('u1', null).buildSystemPrompt();
    expect(prompt).toContain('ALWAYS reply in **Dutch**');
  });

  it('falls back to English for an unmapped app language', async () => {
    setLanguage('xx');
    const prompt = await new TutorialHelpAgent('u1', null).buildSystemPrompt();
    expect(prompt).toContain('ALWAYS reply in **English**');
  });

  it('caches the prompt, and rebuilds it when the language changes', async () => {
    const agent = new TutorialHelpAgent('u1', null);

    const first = await agent.buildSystemPrompt();
    const second = await agent.buildSystemPrompt();
    expect(second).toBe(first);

    setLanguage('nl');
    const third = await agent.buildSystemPrompt();
    expect(third).not.toBe(first);
  });

  // webSearch IS PART OF THE CACHE KEY: otherwise the cached prompt keeps saying "you have no tools
  // at all" after the user turns the toggle on, while the tool payload hands the model one.
  it('rebuilds the prompt when the web-search toggle flips, so prompt and tools agree', async () => {
    const agent = new TutorialHelpAgent('u1', null);
    await setWebSearchInChat(false);
    const off = await agent.buildSystemPrompt();
    expect(off).toContain('no tools at all');

    await setWebSearchInChat(true);
    const on = await agent.buildSystemPrompt();
    expect(on).not.toBe(off);
    expect(on).toContain('Looking something up');
  });
});
