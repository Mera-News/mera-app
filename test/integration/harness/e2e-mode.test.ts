// Guard: no production or staging config can switch E2E mode on, and the e2e config does.
import fs from 'fs';
import path from 'path';
import { isE2EMode } from '@/lib/e2e-mode';

const ROOT = path.resolve(__dirname, '../../..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const fromEnv = (env: Record<string, string | undefined>, flag: string | undefined) =>
  isE2EMode({
    flag,
    graphql: env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT,
    auth: env.EXPO_PUBLIC_AUTH_ENDPOINT,
    inference: env.EXPO_PUBLIC_INFERENCE_ENDPOINT,
  });

const e2eEnv = parseEnv(read('.env.e2e'));
const profiles = Object.entries(
  JSON.parse(read('eas.json')).build as Record<string, { env?: Record<string, string> }>,
);

describe('isE2EMode', () => {
  it('is true for the .env.e2e values (positive control)', () => {
    expect(e2eEnv.EXPO_PUBLIC_E2E).toBe('1');
    expect(fromEnv(e2eEnv, e2eEnv.EXPO_PUBLIC_E2E)).toBe(true);
  });

  it('is false without the flag, even on loopback', () => {
    expect(fromEnv(e2eEnv, undefined)).toBe(false);
    expect(fromEnv(e2eEnv, '0')).toBe(false);
    expect(fromEnv(e2eEnv, 'true')).toBe(false);
  });

  it.each(profiles)('is false for eas.json profile %s with the flag added', (_name, profile) => {
    expect(fromEnv(profile.env ?? {}, '1')).toBe(false);
  });

  it.each([
    ['prod', 'https://graphql.mera.news', 'https://auth.mera.news', 'https://inference.mera.news'],
    [
      'staging',
      'https://graphql.staging.mera.news',
      'https://auth.staging.mera.news',
      'https://inference.staging.mera.news',
    ],
    ['mixed', 'http://10.0.2.2:8790', 'http://10.0.2.2:8790', 'https://inference.mera.news'],
  ])('is false for %s hosts with the flag', (_n, graphql, auth, inference) => {
    expect(isE2EMode({ flag: '1', graphql, auth, inference })).toBe(false);
  });

  it.each([undefined, '', 'not a url', 42, null])(
    'is false and does not throw for endpoint %p',
    (bad) => {
      const ok = 'http://10.0.2.2:8790';
      expect(() => isE2EMode({ flag: '1', graphql: bad, auth: ok, inference: ok })).not.toThrow();
      expect(isE2EMode({ flag: '1', graphql: bad, auth: ok, inference: ok })).toBe(false);
      expect(isE2EMode({ flag: '1', graphql: ok, auth: ok, inference: bad })).toBe(false);
    },
  );
});

describe('config files', () => {
  it('only .env.e2e sets EXPO_PUBLIC_E2E', () => {
    for (const f of ['eas.json', 'app.json', '.env.example']) {
      expect(read(f)).not.toContain('EXPO_PUBLIC_E2E');
    }
  });

  it('.env.e2e sets no third-party SDK keys', () => {
    for (const key of [
      'EXPO_PUBLIC_SENTRY_DSN',
      'EXPO_PUBLIC_REVENUECAT_API_KEY',
      'EXPO_PUBLIC_REVENUECAT_IOS_KEY',
      'EXPO_PUBLIC_REVENUECAT_ANDROID_KEY',
      'EXPO_PUBLIC_INTERCOM_APP_ID',
      'EXPO_PUBLIC_INTERCOM_IOS_KEY',
      'EXPO_PUBLIC_INTERCOM_ANDROID_KEY',
      'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
      'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
      'EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN',
    ]) {
      expect(e2eEnv).not.toHaveProperty(key);
    }
  });
});

describe('app.config.js', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  const build = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const appConfig = require(path.join(ROOT, 'app.config.js'));
    const base = JSON.parse(read('app.json')).expo;
    return appConfig({ config: base });
  };
  const cleartext = (cfg: { plugins: unknown[] }) =>
    cfg.plugins.some(
      (p) =>
        Array.isArray(p) &&
        p[0] === 'expo-build-properties' &&
        p[1]?.android?.usesCleartextTraffic === true,
    );

  it('without the flag: updates on, package com.mera.news, no cleartext', () => {
    delete process.env.EXPO_PUBLIC_E2E;
    const cfg = build();
    expect(cfg.updates?.enabled).not.toBe(false);
    expect(cfg.android.package).toBe('com.mera.news');
    expect(cleartext(cfg)).toBe(false);
  });

  it('with the flag and loopback endpoints: e2e package, scheme, no updates, cleartext (positive control)', () => {
    Object.assign(process.env, e2eEnv);
    const cfg = build();
    expect(cfg.updates.enabled).toBe(false);
    expect(cfg.android.package).toBe('com.mera.news.e2e');
    expect(cfg.scheme).toBe('meraapp-e2e');
    expect(cleartext(cfg)).toBe(true);
  });

  it('with the flag and a prod endpoint: throws', () => {
    Object.assign(process.env, e2eEnv, {
      EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT: 'https://graphql.mera.news',
    });
    expect(build).toThrow();
  });
});
