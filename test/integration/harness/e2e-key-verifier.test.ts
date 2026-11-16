// Guard: the key-verifier stub the e2e build bundles (metro.config.js). The mock gateway serves its
// test keys with no Intel quote, so the bundled real verifier refused every key and the device lane
// never sent a chat request. The stub accepts exactly those keys, and only in E2E mode; every other
// key, and every key outside E2E mode, is judged by the real verifier.
import fs from 'fs';
import path from 'path';
import { TEST_MODEL_KEYS } from '@/test/mock-backend/gateway/keys';

const ROOT = path.resolve(__dirname, '../../..');

type StubModule = typeof import('@/lib/e2e/key-verifier');

/** The stub as a bundle with EXPO_PUBLIC_E2E=flag would load it (E2E_MODE is read at load). */
function loadStub(flag: string | undefined): StubModule {
  const before = process.env.EXPO_PUBLIC_E2E;
  if (flag === undefined) delete process.env.EXPO_PUBLIC_E2E;
  else process.env.EXPO_PUBLIC_E2E = flag;
  try {
    let mod!: StubModule;
    jest.isolateModules(() => {
      mod = require('@/lib/e2e/key-verifier');
    });
    return mod;
  } finally {
    if (before === undefined) delete process.env.EXPO_PUBLIC_E2E;
    else process.env.EXPO_PUBLIC_E2E = before;
  }
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
});
