// The guard for the invisible-card bug.
//
// The card drew its nine primary text nodes NEAR-BLACK on a near-black
// gradient for weeks with a full component suite green over it. The palette is
// the cause: Gluestack's dark ramp is an INVERSION of the light one, so
// `typography-0` is the DARK end (23 23 23) and `typography-950` is the white
// end, and the app mounts `mode="dark"`.
//
// The reason the suite could not see it is the part worth encoding. Every
// existing assertion goes through the rendered tree, and in the rendered tree a
// colour class is still just a class NAME: NativeWind resolves it against CSS
// variables that only exist under a provider jest never mounts. So
// `expect(node.props.className).toContain('text-typography-0')` passes, and so
// does every assertion that never looks at colour at all. A test that cannot
// observe the quantity it is guarding is not a guard. Same shape as the
// per-string locale budget that stayed green while the footer fell off the
// canvas: it measured lines, never the height of the stack.
//
// So this one does not render. It reads the SOURCE of every file in the
// directory and refuses the token outright, which is a question jest can
// actually answer. Comments are stripped first so this file and the two design
// notes can keep explaining the bug by name without tripping their own guard;
// everything else — className, style, a helper, a constant — is in scope.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(__dirname, '..');

/** Source with `//` and block comments removed. Deliberately not a parser: the
 *  only thing it has to get right is not counting prose as code, and a false
 *  POSITIVE here fails loudly rather than hiding a token. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function sourceFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .sort();
}

describe('share-stats ink', () => {
  it('references no typography palette token anywhere in the directory', () => {
    const offenders = sourceFiles().filter((file) =>
      code(readFileSync(join(DIR, file), 'utf8')).includes('text-typography-'),
    );

    // Named, not counted: the failure has to say WHICH file, or the next person
    // to hit it re-derives the whole investigation.
    expect(offenders).toEqual([]);
  });

  it('references no off-system grey literal either', () => {
    // `text-gray-400` is Tailwind's own #9ca3af and survives `theme.extend`, so
    // it was VISIBLE where the palette token was not. That is exactly why the
    // card read as half-broken rather than blank, and why it has to go too:
    // a fixed grey drifts against a live gradient, where white-at-alpha holds a
    // constant relationship to whatever is behind it.
    const offenders = sourceFiles().filter((file) =>
      code(readFileSync(join(DIR, file), 'utf8')).includes('text-gray-'),
    );
    expect(offenders).toEqual([]);
  });

  it('actually reads the files it claims to', () => {
    // Without this the two checks above pass on an empty directory listing, a
    // renamed folder, or a `code()` that strips everything — the shape of a
    // check that cannot fail.
    const files = sourceFiles();
    expect(files).toContain('ShareStatsCard.tsx');
    expect(files).toContain('card-theme.ts');
    expect(files.length).toBeGreaterThanOrEqual(4);

    const card = code(readFileSync(join(DIR, 'ShareStatsCard.tsx'), 'utf8'));
    expect(card).toContain("ink('primary')");
    expect(card.length).toBeGreaterThan(2000);
  });

  it('strips comments without stripping code', () => {
    // `code()` is the one moving part above, and an over-eager version would
    // silently disarm both checks.
    expect(code('// text-typography-0\nconst a = 1;')).not.toContain('text-typography-');
    expect(code('/* text-gray-400 */ const b = 2;')).not.toContain('text-gray-');
    expect(code('const c = "text-typography-0";')).toContain('text-typography-');
    expect(code('// note\nconst d = 3;')).toContain('const d = 3;');
  });
});
