import fs from 'fs';
import path from 'path';

// The thread list insets 12pt; chips with their own side padding started 12pt
// right of Mera's bubble.
it('starter chips add no side padding of their own', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'StarterChips.tsx'), 'utf8');
  expect(src).not.toMatch(/paddingHorizontal: 12/);
});
