// e2ee-crypto must stay loadable outside React Native.
//
// The whole point of the extraction is that a Node harness can build and open a
// real envelope. That property is invisible in a normal jest run — jest resolves
// react-native fine — so it is asserted against the real module graph instead.
//
// NEGATIVE CONTROL INCLUDED. An import-graph assertion that has never been shown
// to fail is not evidence, so the same walk is run against `e2ee-service.ts`,
// which is known to pull all four RN dependencies. If that one ever comes back
// clean, this test is broken, not the code.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// STATIC imports, and with NO jest.mock anywhere in this file. That is itself
// part of the claim: the three e2ee-service suites must mock
// gateway-rate-limiter or they hang under fake timers, and this module needs
// nothing.
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  buildE2EEHeaders,
  bytesToHex,
  decryptContent,
  encryptContent,
  ModelKeyAlgoMismatchError,
} from '../e2ee-crypto';

const E2EE_DIR = resolve(__dirname, '..');

/** Specifiers that cannot survive outside React Native. */
const FORBIDDEN = [/^react-native/, /^expo(-|\/|$)/, /^@sentry\//, /^@better-auth\//];

/** Resolve a relative specifier to a real .ts file, or null for a package. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const c of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Every specifier the file imports, static imports only. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** Walk the local module graph, collecting every package specifier reached. */
function packageGraph(entry: string): { packages: Set<string>; files: string[] } {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  const packages = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const spec of importsOf(file)) {
      // `@/lib/...` is the project alias; treat it as local.
      const aliased = spec.startsWith('@/')
        ? resolve(E2EE_DIR, '..', '..', spec.slice(2))
        : null;
      const local =
        resolveLocal(file, spec) ??
        (aliased
          ? [`${aliased}.ts`, `${aliased}.tsx`, `${aliased}/index.ts`].find((c) =>
              existsSync(c),
            ) ?? null
          : null);
      if (local) {
        if (!seen.has(local)) {
          seen.add(local);
          queue.push(local);
        }
      } else {
        packages.add(spec);
      }
    }
  }
  return { packages, files: [...seen] };
}

function forbiddenIn(entry: string): string[] {
  const { packages } = packageGraph(entry);
  return [...packages].filter((p) => FORBIDDEN.some((re) => re.test(p)));
}

describe('e2ee-crypto import graph', () => {
  it('reaches no react-native, expo, sentry or better-auth module', () => {
    expect(forbiddenIn(resolve(E2EE_DIR, 'e2ee-crypto.ts'))).toEqual([]);
  });

  it('reaches only @noble packages', () => {
    const { packages } = packageGraph(resolve(E2EE_DIR, 'e2ee-crypto.ts'));
    for (const p of packages) expect(p.startsWith('@noble/')).toBe(true);
  });

  // NEGATIVE CONTROL: proves the walk can actually detect the thing it checks.
  it('DOES flag e2ee-service, which is why the split exists', () => {
    const found = forbiddenIn(resolve(E2EE_DIR, 'e2ee-service.ts'));
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('the primitives still work, loaded on their own', () => {
  it('round-trips a message through the ed25519 envelope', () => {
    const secret = ed25519.utils.randomSecretKey();
    const modelPub = ed25519.getPublicKey(secret);
    const ctx = {
      modelPubKeyHex: bytesToHex(modelPub),
      privateKey: secret,
      clientPubKeyHex: bytesToHex(ed25519.getPublicKey(secret)),
      algo: 'ed25519' as const,
      headers: buildE2EEHeaders(
        'ed25519',
        bytesToHex(ed25519.getPublicKey(secret)),
        bytesToHex(modelPub),
      ),
    };
    const blob = encryptContent('hello mera', ctx);
    expect(decryptContent(blob, secret, 'ed25519')).toBe('hello mera');
  });

  it('keeps the algo guard that MERA-APP-39 needed', () => {
    const secret = ed25519.utils.randomSecretKey();
    const ctx = {
      // a 32-byte (ed25519) key paired with an 'ecdsa' context
      modelPubKeyHex: bytesToHex(ed25519.getPublicKey(secret)),
      privateKey: secret,
      clientPubKeyHex: '',
      algo: 'ecdsa' as const,
      headers: {} as never,
    };
    expect(() => encryptContent('x', ctx)).toThrow(ModelKeyAlgoMismatchError);
  });
});

describe('buildE2EEHeaders', () => {
  it('versions ed25519 and leaves ecdsa UNVERSIONED', () => {
    // The rule that fails silently: NEAR rejects the wrong one with a 400
    // carrying "Decryption failed", from a different repo.
    expect(buildE2EEHeaders('ed25519', 'aa', 'bb')['X-Encryption-Version']).toBe('2');
    expect(buildE2EEHeaders('ecdsa', 'aa', 'bb')['X-Encryption-Version']).toBeUndefined();
  });
});
