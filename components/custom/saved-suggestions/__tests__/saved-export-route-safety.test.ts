// Boot safety for the saved-articles export path.
//
// Expo Router eagerly imports every file under `app/` and everything below it
// at JS boot. So a module-scope `import ... from 'expo-sharing'` anywhere in
// this feature is evaluated before the app renders anything, and on a client
// whose BINARY lacks that native module it throws
// `Cannot find native module 'ExpoSharing'` and takes the WHOLE APP DOWN.
//
// That is not hypothetical: it happened once already on an Android harness dev
// client built three days before the commit that banked the module, and the
// crash pointed at `share-stats/capture-and-share.ts`. This is the second file
// in the repo doing native work behind a dynamic import, so it is the second
// one that needs this guard.
//
// `expo-file-system` carries an extra risk the others do not: it is NOT a
// direct dependency and never has been. It reaches the app transitively
// through `expo`, so whether it is in a given binary is a property of what
// `npm ci` resolved, not of package.json.
//
// Each mock below THROWS the way a missing native module does. If any file in
// this path touches one at module scope, the require fails and the test fails
// with the same error a user would have seen at boot.

// Inline factories: jest.mock hoists its second argument and babel refuses a
// reference to anything outside it, so these cannot be generated from a helper.
jest.mock('expo-sharing', () => {
  throw new Error("Cannot find native module 'ExpoSharing'");
});
jest.mock('expo-file-system', () => {
  throw new Error("Cannot find native module 'ExpoFileSystem'");
});
jest.mock('expo-haptics', () => {
  throw new Error("Cannot find native module 'ExpoHaptics'");
});

describe('the export feature cannot break JS boot on a client missing a native module', () => {
  it('loads export-and-share without resolving any native module', () => {
    // The module that OWNS the native calls. If its imports are at module
    // scope this throws, which is precisely the crash being guarded.
    expect(() => require('../export-and-share')).not.toThrow();
  });

  it('still exports its helpers, so deferring the imports did not hollow it out', () => {
    // Without this, the test above would pass on an empty module.
    const { toFileUri, exportAndShare } = require('../export-and-share');

    expect(typeof exportAndShare).toBe('function');
    expect(toFileUri('/var/tmp/x.md')).toBe('file:///var/tmp/x.md');
    expect(toFileUri('file:///var/tmp/x.md')).toBe('file:///var/tmp/x.md');
  });

  it('falls back to a text share rather than throwing when the modules cannot resolve', async () => {
    const { Share } = require('react-native');
    const spy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });

    const { exportAndShare } = require('../export-and-share');
    const result = await exportAndShare({
      content: '# Saved articles\n',
      format: 'markdown',
      dialogTitle: 'Export saved articles',
    });

    // A missing native module costs the FILE, not the feature: the reader
    // still gets their export, as share text. This is the degraded path and
    // the only reason it exists.
    expect(result).toEqual({ status: 'shared', via: 'text' });
    expect(spy).toHaveBeenCalledWith(
      { message: '# Saved articles\n' },
      { subject: 'Export saved articles' },
    );
    spy.mockRestore();
  });

  it('reports failure rather than throwing when even the text share refuses', async () => {
    const { Share } = require('react-native');
    const spy = jest.spyOn(Share, 'share').mockRejectedValue(new Error('no sheet'));

    const { exportAndShare } = require('../export-and-share');
    const result = await exportAndShare({
      content: 'x',
      format: 'json',
      dialogTitle: 'irrelevant',
    });

    expect(result.status).toBe('failed');
    spy.mockRestore();
  });
});

describe('no native import sits at module scope anywhere in the export path', () => {
  // A source-level check as well as a runtime one. The runtime tests above
  // cannot cover the screen and the wizard without stubbing half of gluestack,
  // reanimated and expo-router, and a stub-heavy test that drifts is worse than
  // no test. This reads the files instead, which is exactly the property at
  // stake: what the MODULE GRAPH touches before anything renders.
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');

  const NATIVE = ['expo-sharing', 'expo-file-system', 'expo-haptics', 'react-native-view-shot'];

  const DIR = path.join(__dirname, '..');
  const ROOT = path.join(__dirname, '..', '..', '..', '..');

  // DERIVED from disk, not a hand-kept list. The sibling guard in share-stats
  // keeps its list by hand and needs a second test asserting the list still
  // covers the directory; a list that is read from the directory cannot fall
  // behind it in the first place, so there is nothing for that second test to
  // catch. A file added here is covered the day it lands.
  const inDirectory = fs
    .readdirSync(DIR)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.startsWith('.'))
    .map((f) => `components/custom/saved-suggestions/${f}`);

  // Plus the route that mounts the screen standalone. It is outside the
  // directory and is the actual entry point Expo Router walks.
  const FILES = [...inDirectory, 'app/logged-in/saved-suggestions.tsx'];

  it('has files to check at all, so the loop below cannot pass by being empty', () => {
    // The failure mode this guards: a renamed directory makes readdirSync
    // return nothing, every per-file test disappears, and the suite goes green
    // having checked nothing.
    expect(inDirectory.length).toBeGreaterThanOrEqual(2);
    expect(FILES).toContain('components/custom/saved-suggestions/export-and-share.ts');
  });

  for (const relative of FILES) {
    it(`${relative} has no top-level native import`, () => {
      const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');

      for (const moduleName of NATIVE) {
        // A static `import ... from 'x'` at the start of a line. `import type`
        // erases at compile time and is fine; `await import('x')` is indented
        // inside a function and is the whole point of this design.
        const staticImport = new RegExp(
          `^import\\s+(?!type\\s)[^\\n]*from\\s+['"]${moduleName}['"]`,
          'm',
        );
        expect({ file: relative, moduleName, matched: staticImport.test(source) }).toEqual({
          file: relative,
          moduleName,
          matched: false,
        });
      }
    });
  }
});
