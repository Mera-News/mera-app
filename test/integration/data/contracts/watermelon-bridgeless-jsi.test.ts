// plugins/withWatermelonBridgelessJsi.js retypes WatermelonDB's iOS JSI
// installer from RCTCxxBridge (removed in RN 0.88) to RCTBridge at prebuild.
// The last case reads the INSTALLED sources, so a WatermelonDB bump that moves
// an anchor fails here rather than in an EAS build.
import fs from 'fs';
import path from 'path';

const { patchSource, iosSourceDir, FILES } = require('../../../../plugins/withWatermelonBridgelessJsi');

const H = '#pragma once\n\n#import <React/RCTBridge+Private.h>\n\nvoid installWatermelonJSI(RCTCxxBridge *bridge);\n';
const MM = 'extern "C" void installWatermelonJSI(RCTCxxBridge *bridge) {\n    if (bridge.runtime == nullptr) {\n';
const M = '    __block RCTCxxBridge *bridge = (RCTCxxBridge *) _bridge;\n';

describe('withWatermelonBridgelessJsi', () => {
  it('removes every RCTCxxBridge reference and declares -runtime on RCTBridge', () => {
    const h = patchSource('JSIInstaller.h', H);
    const mm = patchSource('JSIInstaller.mm', MM);
    const m = patchSource('objc/WMDatabaseBridge.m', M);
    for (const out of [h, mm, m]) expect(out).not.toMatch(/RCTCxxBridge|RCTBridge\+Private/);
    expect(mm).toContain('@interface RCTBridge (WatermelonJSIRuntime)\n- (void *)runtime;\n@end');
    expect(mm).toContain('installWatermelonJSI(RCTBridge *bridge)');
  });

  it('leaves an already patched file unchanged', () => {
    const once = patchSource('JSIInstaller.mm', MM);
    expect(patchSource('JSIInstaller.mm', once)).toBe(once);
  });

  it('throws when an anchor moved', () => {
    expect(() => patchSource('objc/WMDatabaseBridge.m', '    id bridge = _bridge;\n')).toThrow(/anchor moved/);
  });

  it.each(FILES as string[])('matches the installed WatermelonDB %s', (file) => {
    const src = fs.readFileSync(path.join(iosSourceDir(process.cwd()), file), 'utf8');
    expect(patchSource(file, src)).not.toMatch(/RCTCxxBridge \*/);
  });
});
