// harness-local — mutable local-data bootstrap.
//
// All mutable state the harness scripts read/write (the persona fixture a
// developer is actively editing, per-run output, cached auth sessions) lives
// under a single gitignored folder: `.local-test-data/`.
// `harness-local/fixtures/**` is TRACKED in git (persona.example.json, the
// goldset-348 pair, persona-chat/, persona-corpus/) — only `.env.harness` and
// `.local-test-data/` are ignored.
//
// Paths here are resolved against `process.cwd()`, which for every wired npm
// script is `mera-app/` — this repo's root, NOT the mera-news directory that
// holds the seven repos. `harness-local/lib/run-writer.ts` anchors its default
// runs root the same way.

import * as fs from 'node:fs';
import * as path from 'node:path';

const LOCAL_DATA_DIRNAME = '.local-test-data';
const PERSONA_EXAMPLE_PATH = path.resolve(__dirname, '..', 'fixtures', 'persona.example.json');

export function localDataRoot(): string {
  return path.resolve(process.cwd(), LOCAL_DATA_DIRNAME);
}

export function defaultPersonaPath(): string {
  return path.join(localDataRoot(), 'persona.json');
}

export function defaultRunsRoot(): string {
  return path.join(localDataRoot(), 'runs');
}

/** Legacy, un-namespaced cache path. Kept only so `authCachePath` can warn
 *  about a leftover file: a session cached under it has no recorded target. */
const LEGACY_AUTH_CACHE = '.auth-cache.json';

let legacyWarned = false;

/**
 * Per-target session cache.
 *
 * NAMESPACED ON PURPOSE. This was ONE file for every target, and the cache is
 * considered fresh for 6 days (adapters/auth.ts). A staging run started inside
 * that window after a prod run therefore presented the PROD session and
 * queried prod while reporting itself as staging — a silent wrong-environment
 * read, not a visible failure. The target is part of the identity of a cached
 * session, so it is part of the filename.
 */
export function authCachePath(target: 'local' | 'staging' | 'prod'): string {
  const legacy = path.join(localDataRoot(), LEGACY_AUTH_CACHE);
  if (!legacyWarned && fs.existsSync(legacy)) {
    legacyWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `harness-local: ignoring the un-namespaced ${LEGACY_AUTH_CACHE} (its target is unknown). ` +
        'Delete it once you have signed in again; sessions are now cached per target.',
    );
  }
  return path.join(localDataRoot(), `.auth-cache.${target}.json`);
}

/**
 * Ensures `.local-test-data/` exists and seeds it with a persona fixture on
 * first run (copied from the tracked `fixtures/persona.example.json`), so a
 * fresh checkout "just works" without a manual copy step. No-ops if the
 * persona file is already there. Called at the top of both harness scripts.
 */
export function ensureLocalTestData(): void {
  const root = localDataRoot();
  const personaPath = defaultPersonaPath();

  if (fs.existsSync(personaPath)) return;

  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(PERSONA_EXAMPLE_PATH, personaPath);
  // eslint-disable-next-line no-console
  console.log(
    `harness-local: initialized ${LOCAL_DATA_DIRNAME}/ — copied fixtures/persona.example.json to ${personaPath}`,
  );
}
