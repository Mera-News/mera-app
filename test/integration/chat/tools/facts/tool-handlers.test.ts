// The small persona tools: language config, the server-authoritative warning, and the Mera
// reference sections. The GraphQL calls go through the real account service and the mock backend.
import { setSetting } from '@/lib/database/services/setting-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { handleExplainMera, handleIssueWarning, handleUpdateUserConfig } from '@/lib/chat-tools/tool-handlers';
import logger from '@/lib/logger';
import { useUserStore } from '@/lib/stores/user-store';
import { fixture, FIXTURE_ACCOUNT, gatewayCalls, mockGql, mockGqlError, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { pollUntil, queuedJobs, recordGql } from './kit';

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  useUserStore.setState({ userId: FIXTURE_ACCOUNT.userId, userPersona: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('handleUpdateUserConfig', () => {
  it('missing or non-array language_codes returns a message and makes no request', async () => {
    const rec = recordGql('UpdateUserConfig');
    server.use(rec.handler);

    expect(await handleUpdateUserConfig({})).toMatchObject({ success: true, message: expect.stringContaining('No config') });
    expect(await handleUpdateUserConfig({ language_codes: 'en' })).toMatchObject({
      success: true,
      message: expect.stringContaining('No config'),
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(rec.calls).toEqual([]);
  });

  it('sends the language codes for the signed-in user and echoes them', async () => {
    const rec = recordGql('UpdateUserConfig');
    server.use(rec.handler);

    const result = await handleUpdateUserConfig({ language_codes: ['en', 'nl'] });

    expect(result).toMatchObject({ success: true, language_codes: ['en', 'nl'] });
    // Fire-and-forget on the server side: the request lands shortly after the result.
    await pollUntil(async () => rec.calls.length, (n) => n > 0);
    expect(rec.calls[0].input).toEqual({ userId: FIXTURE_ACCOUNT.userId, language_codes: ['en', 'nl'] });
  });

  it('skips the server update, and says so, when no user id is known anywhere', async () => {
    useUserStore.setState({ userId: null });
    const rec = recordGql('UpdateUserConfig');
    server.use(rec.handler);
    const warn = jest.spyOn(logger, 'warn');

    const result = await handleUpdateUserConfig({ language_codes: ['fr'] });
    await new Promise((r) => setTimeout(r, 50));

    expect(result).toMatchObject({ success: true, language_codes: ['fr'] });
    expect(rec.calls).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to the cached user id row when the store has none', async () => {
    useUserStore.setState({ userId: null });
    await setSetting('cached_user_id', 'cached-user-789');
    const rec = recordGql('UpdateUserConfig');
    server.use(rec.handler);

    await handleUpdateUserConfig({ language_codes: ['de'] });

    await pollUntil(async () => rec.calls.length, (n) => n > 0);
    expect(rec.calls[0].input).toEqual({ userId: 'cached-user-789', language_codes: ['de'] });
  });

  it('does not reject when the server update fails (fire-and-forget), and logs it', async () => {
    server.use(mockGqlError('UpdateUserConfig', 'INTERNAL_SERVER_ERROR', { message: 'server error' }));
    const warn = jest.spyOn(logger, 'warn');

    const result = await handleUpdateUserConfig({ language_codes: ['es'] });

    expect(result).toMatchObject({ success: true });
    await pollUntil(async () => warn.mock.calls.length, (n) => n > 0);
    expect(warn).toHaveBeenCalled();
  });
});

describe('handleIssueWarning', () => {
  const personaWith = (overrides: Record<string, unknown>) => ({ ...fixture('persona'), userId: FIXTURE_ACCOUNT.userId, ...overrides });

  it('issues a server-authoritative warning for the user and the reason, and reports not blocked', async () => {
    const rec = recordGql('IssueLlmWarning');
    server.use(rec.handler, mockGql('IssueLlmWarning', { issueLlmWarning: personaWith({ llmWarningCount: 1, blockedByLlm: false }) }));

    const result = await handleIssueWarning({ reason: 'Off-topic message' });

    expect(rec.calls[0].input).toEqual({ userId: FIXTURE_ACCOUNT.userId, reason: 'Off-topic message' });
    expect(result).toMatchObject({ blocked: false, warningCount: 1, message: expect.stringContaining('1/3') });
  });

  it('uses a default reason when none is given', async () => {
    const rec = recordGql('IssueLlmWarning');
    server.use(rec.handler, mockGql('IssueLlmWarning', { issueLlmWarning: personaWith({ llmWarningCount: 2 }) }));

    const result = await handleIssueWarning({});

    expect(rec.calls[0].input.reason).toBe('No reason provided');
    expect(result).toMatchObject({ blocked: false, warningCount: 2 });
  });

  it('reports blocked, with the server\'s own reason, when the server blocks the user', async () => {
    server.use(
      mockGql('IssueLlmWarning', {
        issueLlmWarning: personaWith({ llmWarningCount: 3, blockedByLlm: true, blockedByLlmReason: 'Repeated abuse' }),
      }),
    );

    const result = await handleIssueWarning({ reason: 'Third violation' });

    expect(result).toMatchObject({ blocked: true, warningCount: 3, message: 'Repeated abuse', blockedReason: 'Repeated abuse' });
  });

  it('a block with no reason falls back to the generic English line and an empty blockedReason', async () => {
    server.use(mockGql('IssueLlmWarning', { issueLlmWarning: personaWith({ llmWarningCount: 3, blockedByLlm: true, blockedByLlmReason: null }) }));

    const result = await handleIssueWarning({ reason: 'x' });

    expect(result).toMatchObject({ blocked: true, message: expect.stringContaining('blocked'), blockedReason: '' });
  });

  it('syncs the returned persona into the user store', async () => {
    const persona = personaWith({ llmWarningCount: 1 });
    server.use(mockGql('IssueLlmWarning', { issueLlmWarning: persona }));

    await handleIssueWarning({ reason: 'reason' });

    expect(useUserStore.getState().userPersona).toMatchObject({ userId: FIXTURE_ACCOUNT.userId, llmWarningCount: 1 });
  });

  it('fails OPEN (blocked false) when the mutation throws', async () => {
    server.use(mockGqlError('IssueLlmWarning', 'INTERNAL_SERVER_ERROR'));

    const result = await handleIssueWarning({ reason: 'reason' });

    expect(result).toMatchObject({ blocked: false, warningCount: 0 });
  });

  it('fails OPEN, with no request at all, when no user id is available', async () => {
    useUserStore.setState({ userId: null });
    const rec = recordGql('IssueLlmWarning');
    server.use(rec.handler);

    const result = await handleIssueWarning({ reason: 'reason' });

    expect(rec.calls).toEqual([]);
    expect(result).toMatchObject({ blocked: false, warningCount: 0 });
  });

  it('logs the warning it issued', async () => {
    const warn = jest.spyOn(logger, 'warn');
    server.use(mockGql('IssueLlmWarning', { issueLlmWarning: personaWith({ llmWarningCount: 1 }) }));

    await handleIssueWarning({ reason: 'test reason' });

    expect(warn).toHaveBeenCalled();
  });
});

// The CLOUD knowledge tool: a pure read of a frozen reference document. An unknown id comes back as
// a retryable error, never a partial answer the model would then fill in itself.
describe('handleExplainMera', () => {
  it('returns the requested sections, in order, with their text', async () => {
    const result = await handleExplainMera({ topics: ['privacy_what_leaves_device', 'known_gaps'] });

    const sections = result.sections as { topic: string; text: string }[];
    expect(sections.map((s) => s.topic)).toEqual(['privacy_what_leaves_device', 'known_gaps']);
    for (const s of sections) expect(s.text.length).toBeGreaterThan(200);
    expect(result.error).toBeUndefined();
  });

  it('returns availableTopics on an unknown id so the model can retry', async () => {
    const result = await handleExplainMera({ topics: ['how_do_you_make_money'] });

    expect(result.sections).toBeUndefined();
    expect(result.error).toContain('how_do_you_make_money');
    expect(result.availableTopics).toContain('what_is_mera');
    expect(result.availableTopics).toContain('known_gaps');
  });

  it('rejects rather than half-answers when ONE of several ids is unknown', async () => {
    const result = await handleExplainMera({ topics: ['what_is_mera', 'nope'] });
    expect(result.sections).toBeUndefined();
    expect(result.availableTopics).toBeDefined();
  });

  it.each([['missing', {}], ['empty', { topics: [] }], ['not an array', { topics: 'known_gaps' }]])(
    'topics %s errors with availableTopics',
    async (_label, args) => {
      const result = await handleExplainMera(args);
      expect(result.sections).toBeUndefined();
      expect(result.availableTopics).toBeDefined();
    },
  );

  it('caps at 3 sections rather than erroring: an error would burn a round trip', async () => {
    const result = await handleExplainMera({
      topics: ['what_is_mera', 'privacy_what_leaves_device', 'privacy_what_we_store', 'encryption_and_inference', 'how_news_works'],
    });

    expect((result.sections as { topic: string }[]).map((s) => s.topic)).toEqual([
      'what_is_mera',
      'privacy_what_leaves_device',
      'privacy_what_we_store',
    ]);
  });

  it('de-duplicates a repeated id: these are the largest entries in the budget', async () => {
    const result = await handleExplainMera({ topics: ['known_gaps', 'known_gaps'] });
    expect(result.sections).toHaveLength(1);
  });

  it('touches no I/O at all: no fact, no job, no request', async () => {
    await handleExplainMera({ topics: ['what_is_mera'] });
    expect(await getFacts()).toEqual([]);
    expect(await queuedJobs()).toEqual([]);
    expect(gatewayCalls()).toHaveLength(0);
  });
});
