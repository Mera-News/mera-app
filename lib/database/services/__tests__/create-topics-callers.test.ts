/**
 * Freezes the `createTopics` call-site set.
 *
 * `createTopics` now writes into `fact.metadata.topics` for any input
 * carrying a `factId`, which is what keeps the facts screen and the chat card
 * in step. The behavioural invariant that keeps NEGATIVE and TRACKED-STORY
 * topics off the facts screen — "no factId ⇒ no fact row is written" — is
 * tested directly in topic-service-metadata-pairing.test.ts and holds whatever
 * callers do.
 *
 * This file guards the other half, which a code reading cannot: a NEW caller
 * passing a factId puts its topic on the facts screen. That may well be right,
 * but it should be a decision someone makes on purpose, so a new call site
 * fails here and asks.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const LIB = path.join(ROOT, 'lib');

/** file (relative to the repo root) → number of createTopics( CALLS. */
const CALL_SITES: Record<string, number> = {
  'lib/database/services/mutation-rails-service.ts': 1,
  'lib/database/services/persona-action-executor.ts': 2,
  // appendTopupTopicsForFact + syncLlmTopicsForFact delegate here; the
  // declaration itself and the doc-comment mention are stripped below.
  'lib/database/services/topic-service.ts': 2,
  'lib/inference/handlers/tracked-story-migrate-handler.ts': 1,
  'lib/tracking/track-actions.ts': 1,
};
const EXPECTED_TOTAL = 7;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Never descend into duplicate repo trees — they would double every
      // count — or into tests, which legitimately mention the symbol.
      if (entry.name === 'worktrees' || entry.name === '__tests__') continue;
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Count real CALLS, not every textual match.
 *
 * `topic-service.ts` holds two matches that are not calls: the declaration
 * (`export async function createTopics(`) and a doc-comment line quoting
 * `await createTopics([...])`. A naive regex scores that file 4, this test
 * fails on day one, and the natural "fix" is to loosen the assertion until it
 * passes — which is how a guard test becomes decorative. Same failure class
 * the backup allowlist test documents, arriving from the other direction:
 * there a comment HIDES a match, here a comment CREATES one.
 */
function countCalls(source: string): number {
  let n = 0;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
    if (/export\s+(async\s+)?function\s+createTopics\s*\(/.test(line)) continue;
    const matches = line.match(/(?:topicService\.)?\bcreateTopics\s*\(/g);
    if (matches) n += matches.length;
  }
  return n;
}

describe('createTopics call sites are frozen', () => {
  const found: Record<string, number> = {};
  beforeAll(() => {
    for (const file of walk(LIB)) {
      const n = countCalls(fs.readFileSync(file, 'utf8'));
      if (n > 0) found[path.relative(ROOT, file)] = n;
    }
  });

  it('scanned real files, so the checks below are not vacuous', () => {
    // Without this, a regex that silently matched nothing would read as
    // "no unexpected callers" and pass green forever.
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(Object.values(found).reduce((a, b) => a + b, 0)).toBe(EXPECTED_TOTAL);
  });

  it('names exactly the known call sites', () => {
    expect(Object.keys(found).sort()).toEqual(Object.keys(CALL_SITES).sort());
  });

  it('each file calls it the expected number of times', () => {
    expect(found).toEqual(CALL_SITES);
  });
});
