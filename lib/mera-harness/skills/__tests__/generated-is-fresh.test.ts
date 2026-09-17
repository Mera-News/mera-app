/**
 * index.generated.ts must match the markdown it was compiled from.
 *
 * Without this, an edited skill that nobody regenerates ships silently: the
 * markdown is the thing people review and the module is the thing the agent
 * actually loads, so they drift apart with nothing red anywhere.
 *
 * The second test is a negative control and is not optional. A freshness check
 * that compares two strings is worthless if the comparison cannot fail, and
 * "it passed" looks identical either way. So the suite mutates a skill body in
 * a throwaway copy of the tree and asserts the generator notices.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SKILLS_ROOT,
  generateModuleText,
  outFileFor,
  personaDirFor,
  firstDifference,
} from '../generate';

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

describe('index.generated.ts', () => {
  it('is what the generator produces from the current markdown', () => {
    const fresh = generateModuleText();
    const onDisk = fs.readFileSync(outFileFor(SKILLS_ROOT), 'utf8');
    const diff = firstDifference(onDisk, fresh);
    expect(
      diff === null
        ? null
        : `index.generated.ts is stale. Run: npm run skills:generate\n  first difference at ${diff}`,
    ).toBeNull();
  });

  it('notices when a skill body changes and nobody regenerates', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-skills-'));
    try {
      copyTree(SKILLS_ROOT, tmp);
      const before = generateModuleText(tmp);
      // Sanity: the copy reproduces the real tree, so any difference below is
      // caused by the edit and not by the copy.
      expect(before).toBe(fs.readFileSync(outFileFor(SKILLS_ROOT), 'utf8'));

      const victim = path.join(personaDirFor(tmp), 'topics', 'family.md');
      const original = fs.readFileSync(victim, 'utf8');
      fs.writeFileSync(victim, `${original}\nOne more sentence nobody regenerated.\n`, 'utf8');

      const after = generateModuleText(tmp);
      expect(after).not.toBe(before);
      expect(firstDifference(before, after)).not.toBeNull();
      expect(after).toContain('One more sentence nobody regenerated.');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
