// harness-local — mutable local-data bootstrap.
//
// All mutable state the harness scripts read/write (the persona fixture a
// developer is actively editing, per-run output, cached auth sessions) lives
// under a single gitignored folder at the repo root: `.local-test-data/`.
// The only fixture tracked in git is `harness-local/fixtures/persona.example.json`.
//
// Paths here are resolved against `process.cwd()` (scripts are invoked from
// the repo root via `npm run ...`), matching how harness-local/lib/run-writer.ts
// already anchors its default runs root.

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

export function authCachePath(): string {
  return path.join(localDataRoot(), '.auth-cache.json');
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
