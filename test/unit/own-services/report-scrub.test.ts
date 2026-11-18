import { readFileSync } from 'fs';
import { join } from 'path';

import { setReportSecrets } from '@/lib/own-services/report-secrets';
import { scrubDeep, scrubOwnServices } from '@/lib/own-services/report-scrub';

// The allowlist reads the env on first use, which is inside a test.
process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT = 'https://graphql.example-mera.test/graphql';

beforeEach(() => {
  setReportSecrets('ownAi', { hosts: ['ai.own.test'], secrets: ['sk-own-0123456789'] });
  setReportSecrets('ownNews', { hosts: ['news.own.test'], secrets: [] });
});
afterEach(() => {
  setReportSecrets('ownAi', null);
  setReportSecrets('ownNews', null);
});

describe('scrubOwnServices', () => {
  it('replaces a stored key', () => {
    expect(scrubOwnServices('bad auth sk-own-0123456789 here')).toBe('bad auth [key] here');
  });

  it('replaces a pairing link up to the next space or quote', () => {
    expect(scrubOwnServices('open "meraapp://pod-pair?u=https%3A%2F%2Fx&c=abc123" now')).toBe('open "[pairing-link]" now');
    expect(scrubOwnServices('meraapp://pod-pair?c=1 tail')).toBe('[pairing-link] tail');
  });

  it('replaces an own host bare or in a URL, in any case', () => {
    expect(scrubOwnServices('ENOTFOUND ai.own.test')).toBe('ENOTFOUND [own-host]');
    expect(scrubOwnServices('GET https://News.Own.Test/graphql?q=1')).toBe('GET https://[own-host]/graphql?q=1');
  });

  it('replaces any other host with [host], keeping path and query', () => {
    expect(scrubOwnServices('fetch http://evil.example:8080/a/b?x=1 failed')).toBe('fetch https://[host]/a/b?x=1 failed');
  });

  it('keeps an allowed host', () => {
    for (const u of [
      'https://mera.news/x',
      'https://api.mera.news/x',
      'https://u.expo.dev/abc',
      'https://o1.ingest.sentry.io/1',
      'https://huggingface.co/m/resolve/main/f.gguf',
      'https://www.googleapis.com/drive/v3/files',
      'https://apps.apple.com/app/id1',
    ]) {
      expect(scrubOwnServices(`GET ${u}`)).toBe(`GET ${u}`);
    }
  });

  it('keeps the hosts of the configured endpoints', () => {
    const env = process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT;
    expect(env).toBeTruthy();
    expect(scrubOwnServices(`POST ${env}`)).toBe(`POST ${env}`);
  });

  it('turns a vendor host not on the list into [host]', () => {
    expect(scrubOwnServices('https://api.revenuecat.com/v1/x')).toBe('https://[host]/v1/x');
  });

  it('does nothing with an empty registry', () => {
    setReportSecrets('ownAi', null);
    setReportSecrets('ownNews', null);
    expect(scrubOwnServices('ai.own.test sk-own-0123456789')).toBe('ai.own.test sk-own-0123456789');
  });
});

describe('scrubDeep', () => {
  it('walks objects and arrays', () => {
    const out = scrubDeep({ a: 'https://news.own.test/g', b: ['sk-own-0123456789', { c: 'ok' }], n: 3 });
    expect(out).toEqual({ a: 'https://[own-host]/g', b: ['[key]', { c: 'ok' }], n: 3 });
  });

  it('returns a copy and never edits the caller object', () => {
    const live = { a: 'https://news.own.test/g' };
    scrubDeep(live);
    expect(live.a).toBe('https://news.own.test/g');
  });

  it('returns the same object when there is nothing to scrub', () => {
    const clean = { a: ['x'], b: { c: 'y' } };
    expect(scrubDeep(clean)).toBe(clean);
  });

  it('replaces anything nested past the cap instead of letting it through', () => {
    let deep: unknown = 'https://news.own.test/g';
    for (let i = 0; i < 12; i++) deep = { d: deep };
    expect(JSON.stringify(scrubDeep(deep))).not.toContain('news.own.test');
    expect(JSON.stringify(scrubDeep(deep))).toContain('[dropped]');
  });

  it('handles a large event quickly', () => {
    const crumbs = Array.from({ length: 2000 }, (_, i) => ({ m: `GET https://api.mera.news/x/${i} and sk-own-0123456789` }));
    const t = Date.now();
    scrubDeep(crumbs);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('hosts the URL rule must still catch', () => {
  it('strips userinfo and a port with the host', () => {
    expect(scrubOwnServices('https://u:p@home.example:8443/a')).toBe('https://[host]/a');
  });

  it('catches an IPv4 and an IPv6 literal, and a trailing dot', () => {
    expect(scrubOwnServices('https://192.168.1.5:8080/v1')).toBe('https://[host]/v1');
    expect(scrubOwnServices('https://[fd00::1]:8080/v1')).toBe('https://[host]/v1');
    expect(scrubOwnServices('https://mera.news./x')).toBe('https://[host]/x');
  });

  it('catches an own host inside a JSON string and next to a percent-encoded URL', () => {
    expect(scrubOwnServices('{"url":"https://ai.own.test/v1"}')).toBe('{"url":"https://[own-host]/v1"}');
    expect(scrubOwnServices('u=https%3A%2F%2Fai.own.test%2Fv1')).toBe('u=https%3A%2F%2F[own-host]%2Fv1');
  });

  it('removes a stored key from a header dump', () => {
    expect(scrubOwnServices('Authorization: Bearer sk-own-0123456789')).toBe('Authorization: Bearer [key]');
  });
});

// A line regex is enough here: the file is short and any import or require sits on its own line.
it('report-scrub.ts has exactly one import, ./report-secrets', () => {
  const src = readFileSync(join(__dirname, '../../../lib/own-services/report-scrub.ts'), 'utf8');
  const imports = src.match(/^\s*(import\b[^;]*?from\s+['"][^'"]+['"]|import\s+['"][^'"]+['"]|.*\brequire\(['"][^'"]+['"]\))/gm) ?? [];
  expect(imports).toHaveLength(1);
  expect(imports[0]).toContain("'./report-secrets'");
});
