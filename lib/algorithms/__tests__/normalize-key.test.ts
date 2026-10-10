import { normalizeKey, normalizeKeyOrEmpty } from '../normalize-key';

const TABLE: [string, string][] = [
  ['Hello World', 'hello world'],
  ['  padded  ', 'padded'],
  ['a    b\t\tc\n\nd', 'a b c d'],
  [' nbsp inner ', 'nbsp inner'],
  ['﻿bom  text﻿', 'bom text'],
  ['MiXeD\r\nCase', 'mixed case'],
  ['', ''],
  ['   ', ''],
];

describe('normalizeKey', () => {
  it.each(TABLE)('%j -> %j', (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
    expect(normalizeKeyOrEmpty(input)).toBe(expected);
    // the trim-then-lower copies are the same function
    expect(normalizeKey(input)).toBe(input.trim().toLowerCase().replace(/\s+/g, ' '));
  });

  it('maps null and undefined to an empty string', () => {
    expect(normalizeKeyOrEmpty(null)).toBe('');
    expect(normalizeKeyOrEmpty(undefined)).toBe('');
  });
});
