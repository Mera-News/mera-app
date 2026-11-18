// A person's own service host, key and pairing link never ride out in an error report.

const mockSentryInit = jest.fn();
const mockBreadcrumbs = jest.fn(() => ({ name: 'Breadcrumbs' }));
const mockSetTag = jest.fn();
const mockSetContext = jest.fn();
jest.mock('@sentry/react-native', () => ({
  init: mockSentryInit,
  setContext: mockSetContext,
  setTag: mockSetTag,
  feedbackIntegration: jest.fn(() => ({ name: 'FeedbackIntegration' })),
  breadcrumbsIntegration: mockBreadcrumbs,
}));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1', nativeBuildVersion: '1' }));
jest.mock('expo-updates', () => ({ updateId: 'u', channel: 'production', runtimeVersion: '1', isEmbeddedLaunch: false }));

type Crumb = { message?: string; category?: string; data?: Record<string, unknown> };
type Event = {
  message?: string;
  tags?: Record<string, unknown>;
  transaction?: string;
  request?: { url?: string };
  exception?: { values?: { value?: string }[] };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: Crumb[];
};
type Config = {
  beforeBreadcrumb: (c: Crumb) => Crumb | null;
  beforeSend: (e: Event, hint?: { originalException?: unknown }) => Event | null;
};

let config: Config;
// Read in beforeAll: the integration setup clears mock calls before each test.
let crumbArgs: unknown[][] = [];
let tagsAndContexts = '';

beforeAll(() => {
  (global as { __DEV__?: boolean }).__DEV__ = false;
  jest.isolateModules(() => {
    const secrets = require('@/lib/own-services/report-secrets') as typeof import('@/lib/own-services/report-secrets');
    secrets.setReportSecrets('ownAi', { hosts: ['ai.own.test'], secrets: ['sk-own-0123456789'] });
    secrets.setReportSecrets('ownNews', { hosts: ['news.own.test'], secrets: [] });
    secrets.setReportSecrets('pod', { hosts: ['pod.own.test'], secrets: ['pod-token-abcdef123456'] });
    require('@/lib/sentry-init');
  });
  config = mockSentryInit.mock.calls[0][0] as Config;
  crumbArgs = [...mockBreadcrumbs.mock.calls] as unknown[][];
  tagsAndContexts = JSON.stringify([...mockSetTag.mock.calls, ...mockSetContext.mock.calls]);
});
afterAll(() => {
  (global as { __DEV__?: boolean }).__DEV__ = true;
});

describe('error reports carry no own host, link or key', () => {
  it('scrubs host, key and pairing link from a captured error, everywhere', () => {
    const text = 'failed https://ai.own.test/v1 with sk-own-0123456789 via meraapp://pod-pair?u=x&c=y';
    const out = config.beforeSend(
      {
        message: text,
        exception: { values: [{ value: text }] },
        extra: { note: text },
        contexts: { c: { note: text } },
        breadcrumbs: [{ message: text, data: { a: text } }],
      },
      { originalException: new Error('x') },
    )!;
    const sent = JSON.stringify(out);
    for (const leak of ['ai.own.test', 'sk-own-0123456789', 'pod-pair', 'c=y']) expect(sent).not.toContain(leak);
    expect(out.message).toBe('failed https://[own-host]/v1 with [key] via [pairing-link]');
  });

  it('shows no host for a failed request to a non-Mera host', () => {
    const out = config.beforeSend({ message: 'Network request failed: https://home.example.org/graphql' })!;
    expect(out.message).toBe('Network request failed: https://[host]/graphql');
  });

  it('scrubs a crumb holding an own-news URL when it is recorded', () => {
    const out = config.beforeBreadcrumb({ category: 'graphql', message: 'https://news.own.test/graphql', data: { u: 'https://news.own.test/graphql' } })!;
    expect(JSON.stringify(out)).not.toContain('news.own.test');
  });

  it('records no request breadcrumbs at all, and a crumb naming the paired server is scrubbed when recorded', () => {
    expect(crumbArgs).toContainEqual([expect.objectContaining({ fetch: false, xhr: false })]);
    const out = config.beforeBreadcrumb({
      category: 'fetch',
      message: 'POST https://pod.own.test/snapshot',
      data: { url: 'https://pod.own.test/snapshot', method: 'POST', auth: 'Bearer pod-token-abcdef123456' },
    })!;
    expect(JSON.stringify(out)).not.toMatch(/pod\.own\.test|pod-token-abcdef123456/);
    // Nothing that marks a person as running their own server is set as a tag or a context.
    expect(tagsAndContexts.length).toBeGreaterThan(2);
    expect(tagsAndContexts).not.toMatch(/pod|paired|own[_ ]?server|own[_ ]?ai|own[_ ]?news/i);
  });

  it('keeps no pairing code in a breadcrumb', () => {
    const out = config.beforeBreadcrumb({ category: 'app', message: 'link meraapp://pod-pair?u=https%3A%2F%2Fh&c=CODE123' })!;
    expect(JSON.stringify(out)).not.toContain('CODE123');
  });

  it('scrubs tags, the transaction and the request url', () => {
    const out = config.beforeSend({
      message: 'x',
      tags: { url: 'https://news.own.test/graphql' },
      transaction: 'GET https://ai.own.test/v1',
      request: { url: 'https://ai.own.test/v1/chat/completions' },
    })!;
    expect(JSON.stringify(out)).not.toContain('own.test');
  });

  it('keeps an error from Mera that carries no ownServer flag', () => {
    const mera = Object.assign(new Error('g'), { errors: [{ message: 'm', extensions: { code: 'INTERNAL' } }] });
    expect(config.beforeSend({ message: 'x' }, { originalException: mera })).not.toBeNull();
  });

  it('never edits the breadcrumb data object it was handed', () => {
    const data = { u: 'https://news.own.test/graphql' };
    config.beforeBreadcrumb({ category: 'graphql', data });
    expect(data.u).toBe('https://news.own.test/graphql');
  });

  it('drops an error marked ownServer', () => {
    expect(config.beforeSend({ message: 'x' }, { originalException: Object.assign(new Error('x'), { ownServer: true }) })).toBeNull();
  });

  it('drops a GraphQL error whose errors all carry ownServer, keeps a mixed one', () => {
    const gql = (flags: boolean[]) =>
      Object.assign(new Error('g'), { errors: flags.map((f) => ({ message: 'm', extensions: { ownServer: f } })) });
    expect(config.beforeSend({ message: 'x' }, { originalException: gql([true, true]) })).toBeNull();
    expect(config.beforeSend({ message: 'x' }, { originalException: gql([true, false]) })).not.toBeNull();
  });

  it('passes a Mera endpoint URL and an allowlisted vendor URL unchanged', () => {
    const graphql = process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT as string;
    const hf = 'https://huggingface.co/m/resolve/main/f.gguf';
    const out = config.beforeSend({ message: `${graphql} ${hf}` })!;
    expect(out.message).toBe(`${graphql} ${hf}`);
  });
});
