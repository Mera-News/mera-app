// ux2 batch 26: VoiceOver landed on loose chat icons as StaticText glyphs.
// Every icon in the chat carries the decorative-icon props, so no branch a
// render test never reaches can bring one back. Inside a labelled button the
// props are harmless (the label governs); outside one they are the fix.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const FILES = [
  ...fs
    .readdirSync(path.join(ROOT, 'components/custom/floating-chat'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `components/custom/floating-chat/${f}`),
  'components/ui/chat-ai/index.tsx',
];

/** Each `<MaterialIcons ...>` opening tag, attributes included. */
function iconTags(src: string): string[] {
  const tags: string[] = [];
  let i = src.indexOf('<MaterialIcons');
  while (i >= 0) {
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(src.slice(i, j + 1));
    i = src.indexOf('<MaterialIcons', j);
  }
  return tags;
}

const HIDDEN = (tag: string) =>
  tag.includes('{...DECORATIVE_ICON_A11Y}') ||
  (/accessible=\{false\}/.test(tag) &&
    /accessibilityElementsHidden/.test(tag) &&
    /importantForAccessibility="no-hide-descendants"/.test(tag));

it('scans the chat files it claims to', () => {
  expect(FILES.length).toBeGreaterThan(10);
  const total = FILES.reduce((n, f) => n + iconTags(fs.readFileSync(path.join(ROOT, f), 'utf8')).length, 0);
  expect(total).toBeGreaterThan(30);
});

it.each(FILES)('every icon in %s is hidden from accessibility', (file) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const bare = iconTags(src).filter((tag) => !HIDDEN(tag));
  expect(bare).toEqual([]);
});
