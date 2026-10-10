import fs from 'fs';
import path from 'path';

// lib/navigation/tab-bar.ts LIST_END_RESERVE: a list ends above the Mera button,
// not just above the tab bar. A new You-tab scroll page that forgets this fails here.
const PAGES = [
  'components/custom/config-mera/DisplaySettingsScreen.tsx',
  'components/custom/config-mera/NotificationSettingsScreen.tsx',
  'components/custom/config-mera/MeraProtocolSettingsScreen.tsx',
  'components/custom/config-mera/ManageDataScreen.tsx',
  'components/custom/locations/LocationsScreen.tsx',
  'components/custom/persona-audit/PersonaAuditScreen.tsx',
  'components/custom/hygiene/HygieneReviewScreen.tsx',
  'components/custom/publication-preferences/PublicationPreferencesScreen.tsx',
];

describe('You-tab scroll pages end above the Mera button', () => {
  it.each(PAGES)('%s', (rel) => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../..', rel), 'utf8');
    expect(src).toContain('useListEndClearance()');
    const styles = src.match(/contentContainerStyle=\{\{[^\n]*/g) ?? [];
    expect(styles.length).toBeGreaterThan(0);
    for (const s of styles) expect(s).toMatch(/paddingBottom: \w*[cC]learance\b/);
  });
});
