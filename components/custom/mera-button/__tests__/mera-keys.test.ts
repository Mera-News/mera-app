// Every key the button and its chat read through an untyped `t` exists in
// en.json, so a dropped or renamed key fails here instead of rendering a raw
// dot-path to a reader.

import en from '@/lib/locales/en.json';
import { allKeys, statusKey } from '../mera-pages';

function has(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
}

it.each([
  ...allKeys(),
  'meraButton.a11yLabel',
  'floatingChat.title',
  ...(['processing', 'error', 'limited', 'deferred', 'idle'] as const).map(statusKey),
])('%s is in en.json', (key) => {
  expect(has(key)).toBe(true);
});
