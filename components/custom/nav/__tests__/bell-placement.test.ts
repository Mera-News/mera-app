// Owner ruling: the notification bell appears ONLY in the page strip of a
// tab's root pages, never on a pushed screen. This reads the source of every
// app/ and components/ file (comments stripped) and fails on any other
// importer of the bell.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const ALLOWED = new Set([
  'components/custom/nav/PageStrip.tsx',
  'components/custom/notifications/NotificationBellButton.tsx',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('notification bell placement', () => {
  const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'components'))];

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('is rendered only by the page strip', () => {
    const offenders = files
      .map((f) => path.relative(ROOT, f))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => {
        const src = fs
          .readFileSync(path.join(ROOT, rel), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        return /NotificationBellButton/.test(src);
      });
    expect(offenders).toEqual([]);
  });
});
