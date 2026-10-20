// Inference privacy invariant for the built-in model bindings: nothing in
// modules/mera-on-device-llm may reach a cloud model. On Apple that means only
// SystemLanguageModel, never the Private Cloud Compute model; on Android the
// ML Kit client must pin the STABLE release stage, never PREVIEW.
import fs from 'node:fs';
import path from 'node:path';

const MODULE_DIR = path.resolve(__dirname, '../../../modules/mera-on-device-llm');
const PCC = ['PrivateCloudCompute', 'LanguageModel'].join('');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'build' || e.name === 'node_modules' ? [] : files(path.join(dir, e.name));
    return [path.join(dir, e.name)];
  });
}

const all = files(MODULE_DIR);
const kotlin = all.filter((f) => f.endsWith('.kt'));
const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('mera-on-device-llm native guard', () => {
  it('ships both platforms', () => {
    expect(all.some((f) => f.endsWith('.swift'))).toBe(true);
    expect(kotlin.length).toBeGreaterThan(0);
  });

  it('never mentions the Private Cloud Compute model', () => {
    expect(all.filter((f) => read(f).includes(PCC)).map((f) => path.relative(MODULE_DIR, f))).toEqual([]);
  });

  it('pins the ML Kit model to the STABLE release stage', () => {
    const source = kotlin.map(read).join('\n');
    expect(source).toContain('ModelReleaseStage.STABLE');
    expect(source).not.toMatch(/PREVIEW/);
  });
});
