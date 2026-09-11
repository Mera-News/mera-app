// GATE (c): exactly one GluestackUIProvider in the app, at the root.
//
// Run as a TEST, not only as a lint rule, because lint is scoped to changed
// files in this repo and a new provider added in an unlinted file would sail
// through. This is the check that has to fail.
//
// SUBSTITUTE GATE, NOT THE REAL ONE. The plan's safety argument for the wrapper
// deletion was an on-device zero-pixel dark diff, which cannot run this wave (a
// second Metro and a device boot are both forbidden). This proves the STRUCTURE
// is right. It does not prove the PIXELS are unchanged. The on-device diff is a
// required user-run step before any OTA of this branch.

import { execSync } from 'node:child_process';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../../..');

/**
 * P1b. Each of these renders its provider INSIDE an RN `<Modal>`, which is a
 * separate native window. The plan says variables still propagate because
 * nativewind uses React's VariableContext rather than the native view
 * hierarchy — but jest renders Modal inline, so that claim CANNOT be tested
 * here, and a green test would be a verification that cannot fail. They stay
 * wrapped until someone can check it on a device. This list shrinks to zero
 * when P1b lands; it may never grow.
 */
const P1B_MODAL_HOSTS = [
  'components/custom/VideoPlayerModal.tsx',
  'components/custom/auth/LanguageSelector.tsx',
  'components/custom/auth/LegalFooter.tsx',
  'components/custom/config-mera/LanguageSettingsScreen.tsx',
  'components/custom/subscription/EmailCaptureSheet.tsx',
  'components/custom/tutorials/TutorialModalHost.tsx',
];

const ROOT = 'app/_layout.tsx';

function filesRenderingProvider(): string[] {
  let out = '';
  try {
    out = execSync(
      `grep -rl '<GluestackUIProvider' --include='*.tsx' app components`,
      { cwd: REPO, encoding: 'utf8' },
    );
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => !f.includes('__tests__'))
    .filter((f) => !f.startsWith('components/ui/gluestack-ui-provider/'))
    .sort();
}

describe('only the root mounts GluestackUIProvider', () => {
  it('no file outside the root and the P1b allowlist renders one', () => {
    const unexpected = filesRenderingProvider().filter(
      (f) => f !== ROOT && !P1B_MODAL_HOSTS.includes(f),
    );
    expect(unexpected).toEqual([]);
  });

  it('the root still mounts exactly one', () => {
    expect(filesRenderingProvider()).toContain(ROOT);
  });

  it('the P1b allowlist only ever shrinks', () => {
    const present = filesRenderingProvider();
    for (const f of P1B_MODAL_HOSTS) {
      // If this fails the host was unwrapped: delete its allowlist entry too.
      expect(present).toContain(f);
    }
    expect(P1B_MODAL_HOSTS.length).toBeLessThanOrEqual(6);
  });

  it('no screen passes an explicit mode any more; the root passes the resolved one', () => {
    const out = execSync(
      `grep -rn '<GluestackUIProvider mode=' --include='*.tsx' app components || true`,
      { cwd: REPO, encoding: 'utf8' },
    );
    const explicitDark = out
      .split('\n')
      .filter((l) => l.includes('mode="dark"'))
      .map((l) => l.split(':')[0])
      .filter((f) => !P1B_MODAL_HOSTS.includes(f));
    expect(explicitDark).toEqual([]);
    expect(out).toContain('mode={resolvedTheme}');
  });
});
