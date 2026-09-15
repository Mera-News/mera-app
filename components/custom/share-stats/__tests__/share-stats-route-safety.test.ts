// Boot safety for the share-stats route.
//
// Expo Router eagerly imports every file under `app/` and everything below it
// at JS boot. So a module-scope `import ... from 'expo-sharing'` anywhere in
// this feature is evaluated before the app renders anything, and on a client
// whose BINARY lacks that native module it throws
// `Cannot find native module 'ExpoSharing'` and takes the WHOLE APP DOWN.
//
// That is not hypothetical. The Android harness emulator's dev client was built
// 2026-08-14, three days before the commit that banked these modules, and it
// crashed at boot with exactly that error, pointing at `capture-and-share.ts`.
//
// All three modules ARE in the 1.3.1 production binary (proved by ancestry in
// the plan doc), so this guards the blast radius rather than a shipping bug: a
// share card is the least important thing in the app and must never be able to
// stop it starting.
//
// Each mock below THROWS the way a missing native module does. If any of these
// files touches one at module scope, the require fails and the test fails with
// the same error a user would have seen at boot.

// Inline factories: jest.mock hoists its second argument and babel refuses a
// reference to anything outside it, so these cannot be generated from a helper.
jest.mock('expo-sharing', () => {
  throw new Error("Cannot find native module 'ExpoSharing'");
});
jest.mock('react-native-view-shot', () => {
  throw new Error("Cannot find native module 'RNViewShot'");
});
jest.mock('expo-haptics', () => {
  throw new Error("Cannot find native module 'ExpoHaptics'");
});

describe('the share feature cannot break JS boot on a client missing a native module', () => {
  it('loads capture-and-share without resolving any native module', () => {
    // The module that OWNS the native calls. If its imports are at module
    // scope this throws, which is precisely the crash being guarded.
    expect(() => require('../capture-and-share')).not.toThrow();
  });

  it('still exports its pure helper, so deferring the imports did not hollow it out', () => {
    // Without this, the test above would pass on an empty module.
    const { toFileUri, captureAndShare } = require('../capture-and-share');

    expect(typeof captureAndShare).toBe('function');
    expect(toFileUri('/var/tmp/x.png')).toBe('file:///var/tmp/x.png');
  });

  it('reports unavailable rather than throwing when the modules cannot resolve', async () => {
    const { captureAndShare } = require('../capture-and-share');

    const result = await captureAndShare({
      ref: { current: null },
      hostWidth: 360,
      hostHeight: 640,
      dialogTitle: 'irrelevant',
    });

    // A missing native module IS unavailability: the user gets the inline
    // "sharing is not available" line, not a generic failure and not a crash.
    expect(result).toEqual({ status: 'unavailable' });
  });
});

describe('no native import sits at module scope anywhere in the share path', () => {
  // A source-level check as well as a runtime one. The runtime tests above
  // cannot cover the route and the screen without stubbing half of gluestack,
  // reanimated and expo-router, and a stub-heavy test that drifts is worse than
  // no test. This reads the files instead, which is exactly the property at
  // stake: what the MODULE GRAPH touches before anything renders.
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');

  const NATIVE = ['expo-sharing', 'react-native-view-shot', 'expo-haptics', 'expo-file-system'];

  const FILES = [
    'app/logged-in/share-stats.tsx',
    'components/custom/share-stats/ShareStatsPreviewScreen.tsx',
    'components/custom/share-stats/ShareStatsCard.tsx',
    'components/custom/share-stats/capture-and-share.ts',
  ];

  for (const relative of FILES) {
    it(`${relative} has no top-level native import`, () => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', '..', relative),
        'utf8',
      );

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
