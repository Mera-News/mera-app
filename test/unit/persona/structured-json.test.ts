// The tolerant reader for on-device structured replies: balanced JSON candidates out of prose and
// fences, the schema check, and the first value that fits.
import { fitsSchema, jsonCandidates, readStructured, type JsonSchema } from '@/lib/mera-protocol-toolkit/core/structured-json';

const OPTIONS: JsonSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    intent: { type: 'string', enum: ['track', 'less', 'more'] },
    options: {
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string' }, search: { type: 'string' } }, required: ['label', 'search'] },
      minItems: 1,
      maxItems: 2,
    },
  },
  required: ['reply', 'options'],
};

describe('jsonCandidates', () => {
  it('finds balanced objects in order, nested ones too, ignoring brackets inside strings', () => {
    const text = 'x {"a":"}]"} y {"b":[1,{"c":2}]} z {broken';
    expect(jsonCandidates(text, '{')).toEqual(['{"a":"}]"}', '{"b":[1,{"c":2}]}', '{"c":2}']);
  });

  it('an escaped quote does not end a string', () => {
    expect(jsonCandidates('{"a":"say \\"}\\" ok"}', '{')).toEqual(['{"a":"say \\"}\\" ok"}']);
  });

  it('finds arrays, and skips a span whose closer is the other kind', () => {
    expect(jsonCandidates('see [1, 2] and [3', '[')).toEqual(['[1, 2]']);
    expect(jsonCandidates('{"a": 1]', '{')).toEqual([]);
  });
});

describe('fitsSchema', () => {
  it('checks required keys, nested types and enums', () => {
    expect(fitsSchema({ reply: 'r', options: [{ label: 'l', search: 's' }] }, OPTIONS)).toBe(true);
    expect(fitsSchema({ reply: 'r' }, OPTIONS)).toBe(false);
    expect(fitsSchema({ reply: 'r', options: [{ label: 'l' }] }, OPTIONS)).toBe(false);
    expect(fitsSchema({ reply: 'r', intent: 'other', options: [{ label: 'l', search: 's' }] }, OPTIONS)).toBe(false);
    expect(fitsSchema({ reply: 1, options: [{ label: 'l', search: 's' }] }, OPTIONS)).toBe(false);
    expect(fitsSchema(3, { type: 'integer' })).toBe(true);
    expect(fitsSchema(3.5, { type: 'integer' })).toBe(false);
    expect(fitsSchema(Number.NaN, { type: 'number' })).toBe(false);
    expect(fitsSchema(false, { type: 'boolean' })).toBe(true);
  });

  it('enforces minItems, and cuts an array over maxItems instead of rejecting it', () => {
    expect(fitsSchema({ reply: 'r', options: [] }, OPTIONS)).toBe(false);
    const value = { reply: 'r', options: [1, 2, 3].map((n) => ({ label: `l${n}`, search: `s${n}` })) };
    expect(fitsSchema(value, OPTIONS)).toBe(true);
    expect(value.options.map((o) => o.label)).toEqual(['l1', 'l2']);
  });
});

describe('readStructured', () => {
  const good = '{"reply":"r","options":[{"label":"l","search":"s"}]}';

  it('reads a bare reply, a fenced reply, and one wrapped in prose', () => {
    for (const text of [good, '```json\n' + good + '\n```', 'Here you go: ' + good + ' Hope that helps {x}.']) {
      expect(readStructured(text, OPTIONS)).toEqual({ reply: 'r', options: [{ label: 'l', search: 's' }] });
    }
  });

  it('skips an earlier object that does not fit and takes the first that does', () => {
    expect(readStructured('{"note":1} then ' + good, OPTIONS)).toEqual(JSON.parse(good));
  });

  it('reads an array root', () => {
    expect(readStructured('Topics: ["a","b"]', { type: 'array', items: { type: 'string' } })).toEqual(['a', 'b']);
  });

  it('is undefined when nothing fits', () => {
    expect(readStructured('no json', OPTIONS)).toBeUndefined();
    expect(readStructured('{"reply":"r"}', OPTIONS)).toBeUndefined();
    expect(readStructured('{"reply":"r","options":[{"label":"l","search":"s"}]', OPTIONS)).toBeUndefined();
  });
});
