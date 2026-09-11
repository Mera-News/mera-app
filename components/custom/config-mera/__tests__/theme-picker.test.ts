// The Appearance picker's two non-obvious rules, asserted against source rather
// than a render, because DisplaySettingsScreen pulls the whole settings module
// graph and this is a structural contract, not a visual one.

import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../DisplaySettingsScreen.tsx'),
  'utf8',
);

describe('the theme picker', () => {
  it('offers exactly Dark and Light', () => {
    const values = [...SRC.matchAll(/value: '(\w+)' as const/g)].map((m) => m[1]);
    expect(values.sort()).toEqual(['dark', 'light']);
  });

  it("offers no 'System' option while the iOS plist pin stands", () => {
    // app.json pins ios.infoPlist.UIUserInterfaceStyle to Dark, so Appearance
    // can never report anything else and a System choice would silently mean
    // Dark. It arrives with the native release that removes the pin.
    expect(SRC).not.toContain("value: 'system'");
    const appJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../../app.json'), 'utf8'),
    );
    expect(appJson.expo.ios.infoPlist.UIUserInterfaceStyle).toBe('Dark');
  });

  it('gates the SELECTION on hydration, not the press', () => {
    // The store defaults to dark, so ticking before hydration would show Dark
    // selected to a user whose stored preference is Light.
    expect(SRC).toContain('themeHydrated && themePreference === value');
    // The handler is not gated: a tap before hydration still applies.
    expect(SRC).toContain('onPress={() => void setThemePreference(value)}');
  });

  it('subscribes with separate selectors so the screen does not re-render on every store write', () => {
    expect(SRC).toContain('useThemeStore((s) => s.preference)');
    expect(SRC).toContain('useThemeStore((s) => s.hydrated)');
  });
});
