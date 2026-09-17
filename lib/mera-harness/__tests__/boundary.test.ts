// boundary.test.ts — the whole of lib/mera-harness must stay RN-free.
//
// The folder is meant to be liftable into its own project, so the rule is the
// FOLDER, not one entry file: a purity check scoped to core.ts drifts the
// moment someone adds a sibling. Ports are injected; the RN driver, the DB tool
// port and the UI live outside and import from '@/lib/mera-harness'.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const HARNESS_DIR = join(__dirname, '..');

/** Import specifiers that must never appear anywhere under lib/mera-harness. */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /^react$/, why: 'React' },
  { pattern: /^react-native(\/|$)/, why: 'React Native' },
  { pattern: /^react-dom(\/|$)/, why: 'React DOM' },
  { pattern: /^expo(-|\/|$)/, why: 'Expo' },
  { pattern: /^@react-navigation(\/|$)/, why: 'React Navigation' },
  { pattern: /^zustand(\/|$)/, why: 'Zustand' },
  { pattern: /^@nozbe\/watermelondb(\/|$)/, why: 'WatermelonDB' },
  { pattern: /^@apollo\/client(\/|$)/, why: 'Apollo' },
  // Match the SEGMENT, not a `lib/`-anchored path: a relative escape out of
  // this folder reads `../../database/services/x` and carries no `lib/` at all.
  // The negative control below caught exactly that hole.
  { pattern: /(^|\/)database(\/|$)/, why: 'the database layer' },
  { pattern: /(^|\/)stores(\/|$)/, why: 'the Zustand stores' },
  { pattern: /(^|\/)hooks(\/|$)/, why: 'the RN hooks' },
  { pattern: /(^|\/)components(\/|$)/, why: 'components' },
  { pattern: /(^|\/)harness-local(\/|$)/, why: 'harness-local' },
  { pattern: /(^|\/)logger$/, why: 'the app logger' },
  { pattern: /(^|\/)place-service$/, why: 'place-service (Bloc is declared HERE instead)' },
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const re of [IMPORT_RE, REQUIRE_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) found.push(m[1]);
  }
  return found;
}

function offendersIn(source: string): { spec: string; why: string }[] {
  const bad: { spec: string; why: string }[] = [];
  for (const spec of specifiersOf(source)) {
    const normalised = spec.replace(/^@\//, '');
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(spec) || pattern.test(normalised)) bad.push({ spec, why });
    }
  }
  return bad;
}

describe('lib/mera-harness is RN-free', () => {
  const files = walk(HARNESS_DIR).filter((f) => !f.includes(`${'__tests__'}/boundary.test`));

  it('finds source files to check (guards a matcher that never fires)', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files.map((f) => [f.slice(HARNESS_DIR.length + 1), f]))(
    '%s imports nothing platform-bound',
    (_label, full) => {
      const bad = offendersIn(readFileSync(full as string, 'utf8'));
      expect(
        bad.map((b) => `${b.spec} (${b.why})`),
      ).toEqual([]);
    },
  );

  // NEGATIVE CONTROL. Without this the whole suite passes when the detector is
  // broken -- which is exactly how a purity test reads green while importing
  // half of React Native.
  it('the detector actually catches a forbidden import', () => {
    const rnDriver = `
      import { useRef } from 'react';
      import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
      import { getFacts } from '../database/services/fact-service';
    `;
    const bad = offendersIn(rnDriver);
    expect(bad.map((b) => b.spec).sort()).toEqual([
      '../database/services/fact-service',
      '@/lib/stores/cloud-chat-store',
      'react',
    ]);
  });

  it('allows the relative and type-only imports the harness does use', () => {
    const ok = `
      import type { Bloc } from './types';
      import { contentJaccard } from '../core/topic-similarity';
    `;
    expect(offendersIn(ok)).toEqual([]);
  });
});
