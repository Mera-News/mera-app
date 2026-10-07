// Every key the page table hands the chat through an untyped `t` exists in
// en.json, so a dropped or renamed key fails here instead of rendering a raw
// dot-path to a reader.

import en from '@/lib/locales/en.json';
import { allKeys } from '../mera-pages';

function has(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string';
}

// The button's own labels are literal keys checked by tsc; only the page
// table's computed keys need this.
it.each(allKeys())('%s is in en.json', (key) => {
  expect(has(key)).toBe(true);
});
