// Guard: the key-verifier stub the e2e build bundles (metro.config.js). The mock gateway serves its
// test keys with no Intel quote, so the bundled real verifier refused every key and the device lane
// never sent a chat request. The stub accepts exactly those keys, and only in E2E mode; every other
// key, and every key outside E2E mode, is judged by the real verifier.
import fs from 'fs';
import path from 'path';
import { TEST_MODEL_KEYS } from '@/test/mock-backend/gateway/keys';

const ROOT = path.resolve(__dirname, '../../..');

type StubModule = typeof import('@/lib/e2e/key-verifier');

/** Run `fn` with these env values set (undefined deletes), then restore them. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const apply = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(env);
  try {
    return fn();
  } finally {
    apply(before);
  }
}

/** The stub as a bundle built with these env values would load it (E2E_MODE is read at load). */
function loadStub(flag: string | undefined, env: Record<string, string | undefined> = {}): StubModule {
  return withEnv({ EXPO_PUBLIC_E2E: flag, ...env }, () => {
    let mod!: StubModule;
    jest.isolateModules(() => {
      mod = require('@/lib/e2e/key-verifier');
    });
    return mod;
  });
}

/** What metro.config.js resolves e2ee-service's `./key-verifier` import to, for this flag. */
function resolveKeyVerifier(flag: string | undefined): string {
  return withEnv({ EXPO_PUBLIC_E2E: flag, E2E_DEVICE_BUILD: undefined }, () => {
    let resolved = '';
    jest.isolateModules(() => {
      const config = require(path.join(ROOT, 'metro.config.js'));
      const context = {
        originModulePath: path.join(ROOT, 'lib/e2ee/e2ee-service.ts'),
        // Metro's resolution shape: NativeWind's wrapper reads filePath off it.
        resolveRequest: (_c: unknown, name: string) => ({ type: 'sourceFile', filePath: name }),
      };
      resolved = config.resolver.resolveRequest(context, './key-verifier', 'android').filePath;
    });
    return resolved;
  });
}

const served = (signingPublicKey: string, signingAlgo: string) => ({
  quoteHex: '',
  signingPublicKey,
  signingAlgo,
});

describe('e2e key-verifier stub', () => {
  it('exports every name e2ee-service imports from the real module', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/e2ee/e2ee-service.ts'), 'utf8');
    const block = source.match(/import \{([^}]*)\} from '\.\/key-verifier'/);
    const names = block![1].split(',').map((n) => n.trim()).filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    const stub = loadStub('1') as unknown as Record<string, unknown>;
    for (const name of names) expect(typeof stub[name]).toBe('function');
  });

  it('accepts the mock test keys in E2E mode, in every form the gateway serves them', () => {
    const { verifyKey } = loadStub('1');
    const ed = TEST_MODEL_KEYS.ed25519.publicKeyHex;
    const ec = TEST_MODEL_KEYS.ecdsa.publicKeyHex;
    expect(verifyKey(served(ed, 'ed25519'))).toEqual([]);
    expect(verifyKey(served(`0x${ed}`, 'ed25519'))).toEqual([]);
    expect(verifyKey(served(ec, 'ecdsa'))).toEqual([]);
    expect(verifyKey(served(`04${ec}`, 'ecdsa'))).toEqual([]);
    expect(verifyKey(served(`0x04${ec.toUpperCase()}`, 'ecdsa'))).toEqual([]);
  });

  it('judges any other key for real in E2E mode', () => {
    const { verifyKey } = loadStub('1');
    const other = 'ab'.repeat(32);
    expect(verifyKey(served(other, 'ed25519')).map((c) => c.id)).toContain('quote-structure');
  });

  it('judges even the test keys for real outside E2E mode', () => {
    const { verifyKey } = loadStub(undefined);
    const ed = TEST_MODEL_KEYS.ed25519.publicKeyHex;
    expect(verifyKey(served(ed, 'ed25519')).map((c) => c.id)).toContain('quote-structure');
  });

  // The flag alone is not E2E mode: a leaked flag with a real endpoint must still refuse.
  it('judges the test keys for real when the flag is set but an endpoint is not loopback', () => {
    const { verifyKey } = loadStub('1', { EXPO_PUBLIC_INFERENCE_ENDPOINT: 'https://inference.example.com' });
    const ed = TEST_MODEL_KEYS.ed25519.publicKeyHex;
    expect(verifyKey(served(ed, 'ed25519')).map((c) => c.id)).toContain('quote-structure');
  });
});

describe('metro.config.js key-verifier alias', () => {
  it('leaves the real verifier in place without EXPO_PUBLIC_E2E', () => {
    expect(resolveKeyVerifier(undefined)).toBe('./key-verifier');
    expect(resolveKeyVerifier('0')).toBe('./key-verifier');
  });

  it('swaps in the stub for an e2e build', () => {
    expect(resolveKeyVerifier('1')).toBe(path.join(ROOT, 'lib/e2e/key-verifier.ts'));
  });
});
