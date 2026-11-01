// Make WatermelonDB's iOS JSI installer compile on React Native 0.88.
//
// RN 0.88 removed RCTCxxBridge, and @nozbe/watermelondb 0.28.0 (and 0.28.1-0)
// still types its installer with it, so the pod fails with "unknown type name
// 'RCTCxxBridge'". The app runs bridgeless: the module's `bridge` is an
// RCTBridgeProxy, which still answers -runtime with the live jsi::Runtime. The
// edit takes a plain RCTBridge and declares -runtime in a category, the same
// change as upstream's open PR (Nozbe/WatermelonDB#1978). initializeJSI stays a
// blocking sync method, so the JS thread is parked while the install runs.
//
// A dangerous mod on node_modules, like withWatermelonBusyTimeout.js, because
// the pod compiles these files from node_modules and the repo has no
// patch-package. Each file is idempotent and throws if its anchor moved: a
// silently skipped edit is a red iOS build, or worse, no JSI. Delete this
// plugin once a WatermelonDB release ships the fix (the contract test then
// sees the patched form already installed).

const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const EDITS = {
  'JSIInstaller.h': [
    ['#import <React/RCTBridge+Private.h>', '#import <React/RCTBridge.h>'],
    ['void installWatermelonJSI(RCTCxxBridge *bridge);', 'void installWatermelonJSI(RCTBridge *bridge);'],
  ],
  'JSIInstaller.mm': [
    [
      'extern "C" void installWatermelonJSI(RCTCxxBridge *bridge) {',
      '// RN 0.88 dropped the Cxx bridge class; bridgeless RCTBridgeProxy answers -runtime.\n' +
        '@interface RCTBridge (WatermelonJSIRuntime)\n' +
        '- (void *)runtime;\n' +
        '@end\n\n' +
        'extern "C" void installWatermelonJSI(RCTBridge *bridge) {',
    ],
  ],
  'objc/WMDatabaseBridge.m': [
    ['__block RCTCxxBridge *bridge = (RCTCxxBridge *) _bridge;', '__block RCTBridge *bridge = _bridge;'],
  ],
};

/** Returns the patched source of one file; throws when neither form is present. */
function patchSource(file, src) {
  let out = src;
  for (const [from, to] of EDITS[file]) {
    if (out.includes(to)) continue;
    if (!out.includes(from)) {
      throw new Error(`withWatermelonBridgelessJsi: anchor moved in WatermelonDB ${file}: ${from}`);
    }
    out = out.replace(from, to);
  }
  return out;
}

function iosSourceDir(projectRoot) {
  const pkg = require.resolve('@nozbe/watermelondb/package.json', { paths: [projectRoot] });
  return path.join(path.dirname(pkg), 'native', 'ios', 'WatermelonDB');
}

function withWatermelonBridgelessJsi(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const dir = iosSourceDir(cfg.modRequest.projectRoot);
      for (const file of Object.keys(EDITS)) {
        const full = path.join(dir, file);
        const src = fs.readFileSync(full, 'utf8');
        const next = patchSource(file, src);
        if (next !== src) fs.writeFileSync(full, next);
      }
      return cfg;
    },
  ]);
}

module.exports = withWatermelonBridgelessJsi;
module.exports.patchSource = patchSource;
module.exports.iosSourceDir = iosSourceDir;
module.exports.FILES = Object.keys(EDITS);
