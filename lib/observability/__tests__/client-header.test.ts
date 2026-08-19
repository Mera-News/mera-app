// client-header computes its value ONCE at module scope (see the module header
// for why), so the module-scope cases below re-require it via
// jest.resetModules() to get a fresh evaluation under different mocks.
//
// expo-application and expo-updates have NO global mock in jest.setup.js (only
// expo-device does), so they are mocked per-file here, same as
// lib/__tests__/sentry-init.test.ts.
jest.mock('expo-application', () => ({
  nativeApplicationVersion: '1.2.3',
  nativeBuildVersion: '456',
}));
jest.mock('expo-updates', () => ({
  updateId: 'update-abc',
  channel: 'production',
  runtimeVersion: '1.2.3',
  isEmbeddedLaunch: false,
}));

import type { StaticAppContext } from '../app-context';
import {
  CLIENT_HEADER_NAME,
  clientHeaderValue,
  formatClientHeader,
} from '../client-header';

// The shape the server parses: <platform>/<version>+<build> rt/<runtime>.
// A value missing the +build or rt/ segment reads as "unknown client".
const WELL_FORMED = /^[a-z]+\/\S+\+\S+ rt\/\S+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function makeCtx(overrides: Partial<StaticAppContext> = {}): StaticAppContext {
  return {
    app_version: '1.3.0',
    app_build: '412',
    platform: 'ios',
    os_version: '18.5',
    device_tier: 'high',
    ota_update_id: 'update-abc',
    ota_channel: 'production',
    runtime_version: '1.3.0',
    is_embedded_launch: false,
    ...overrides,
  };
}

describe('client-header', () => {
  it('exports the header name the server parses, lowercase', () => {
    expect(CLIENT_HEADER_NAME).toBe('x-mera-client');
  });

  describe('formatClientHeader', () => {
    it('builds a well-formed value from real-shaped context', () => {
      expect(formatClientHeader(makeCtx())).toBe('ios/1.3.0+412 rt/1.3.0');
    });

    it('lowercases the platform segment', () => {
      const value = formatClientHeader(makeCtx({ platform: 'iOS' }));
      expect(value).toBe('ios/1.3.0+412 rt/1.3.0');
    });

    it('stays valid and parseable when every field sits at its failure sentinel', () => {
      const value = formatClientHeader(
        makeCtx({
          app_version: 'unknown',
          app_build: 'unknown',
          runtime_version: 'unknown',
          ota_update_id: 'embedded',
          ota_channel: 'embedded',
          device_tier: 'unknown',
          is_embedded_launch: true,
        }),
      );
      expect(value).toBe('ios/unknown+unknown rt/unknown');
      expect(value).toMatch(WELL_FORMED);
    });

    it('falls back to no header (null) rather than emitting a value over 120 chars', () => {
      const value = formatClientHeader(
        makeCtx({ app_version: 'x'.repeat(500) }),
      );
      expect(value).toBeNull();
    });

    it('never yields a value exceeding 120 chars across a sweep of input lengths', () => {
      for (const len of [1, 40, 100, 110, 118, 119, 120, 121, 150, 500]) {
        const value = formatClientHeader(
          makeCtx({ app_version: 'v'.repeat(len) }),
        );
        expect(value === null || value.length <= 120).toBe(true);
      }
    });

    it('strips newline, CR, and other control chars while keeping the value parseable', () => {
      const value = formatClientHeader(
        makeCtx({
          app_version: '1.3\n.0',
          app_build: '4\r12',
          runtime_version: '1.\u00003.\u007F0',
        }),
      );
      expect(value).toBe('ios/1.3.0+412 rt/1.3.0');
      expect(value).not.toMatch(CONTROL_CHARS);
      expect(value).toMatch(WELL_FORMED);
    });
  });

  describe('clientHeaderValue (module-scope, computed once)', () => {
    it('is built from app-context values at module load', () => {
      // jest-expo's Platform.OS is 'ios'; versions come from the per-file
      // expo mocks above via the real app-context module.
      expect(clientHeaderValue).toBe('ios/1.2.3+456 rt/1.2.3');
      expect(clientHeaderValue).toMatch(WELL_FORMED);
    });

    it('is null (no header sent) when getStaticAppContext throws, instead of throwing', () => {
      jest.resetModules();
      jest.doMock('../app-context', () => ({
        getStaticAppContext: () => {
          throw new Error('native read failed pre-first-unlock');
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('../client-header') as typeof import('../client-header');
      expect(fresh.clientHeaderValue).toBeNull();
      jest.dontMock('../app-context');
    });
  });
});
