import { createThinkStripper, stripThinkTags } from '../think-strip';

/** Every way to cut `text` into two chunks, plus one chunk per character. */
function chunkings(text: string): string[][] {
  const out: string[][] = [[text], text.split('')];
  for (let i = 1; i < text.length; i++) out.push([text.slice(0, i), text.slice(i)]);
  return out;
}

function streamed(chunks: string[]): string {
  const s = createThinkStripper();
  return chunks.map((c) => s.push(c)).join('') + s.flush();
}

describe('stripThinkTags', () => {
  it('keeps the answer before a stray closing tag (the device report)', () => {
    expect(stripThinkTags('Your parents live in Neerja Nagar, Bhopal. </think>')).toBe(
      'Your parents live in Neerja Nagar, Bhopal. ',
    );
  });

  it('removes a well-formed block and keeps what follows', () => {
    expect(stripThinkTags('<think>they said Bhopal</think>Your parents live in Bhopal.')).toBe(
      'Your parents live in Bhopal.',
    );
  });

  it('removes an empty block', () => {
    expect(stripThinkTags('<think></think>Hello')).toBe('Hello');
  });

  it('removes a nested block whole', () => {
    expect(stripThinkTags('<think>a<think>b</think>c</think>Done.')).toBe('Done.');
  });

  it('drops an opening tag with no pair and keeps the text', () => {
    expect(stripThinkTags('<think>Got it, Porto.')).toBe('Got it, Porto.');
  });

  it('is case and inner-space tolerant', () => {
    expect(stripThinkTags('A<THINK >x</ Think>B')).toBe('AB');
  });

  it('leaves ordinary angle brackets alone', () => {
    expect(stripThinkTags('a < b and <b>bold</b>')).toBe('a < b and <b>bold</b>');
  });
});

describe('createThinkStripper', () => {
  const cases = [
    'Your parents live in Neerja Nagar, Bhopal. </think>',
    '<think>trace</think>Answer here.',
    'Pre <think>x<think>y</think>z</think> post',
    '<think>Got it, Porto.',
    'a < b, then </thin and <thinking> stays',
    '<think></think>',
    'plain text',
  ];

  it.each(cases)('streams to the same text as the whole-string strip, at every split: %s', (text) => {
    const whole = stripThinkTags(text);
    for (const chunks of chunkings(text)) {
      expect(streamed(chunks)).toBe(whole);
    }
  });

  it('holds a tag split across chunks instead of leaking it', () => {
    const s = createThinkStripper();
    expect(s.push('Bhopal. </th')).toBe('Bhopal. ');
    expect(s.push('ink>')).toBe('');
    expect(s.flush()).toBe('');
  });

  it('shows nothing from inside a block while it streams', () => {
    const s = createThinkStripper();
    expect(s.push('<think>reasoning')).toBe('');
    expect(s.push(' more</think>Hi')).toBe('Hi');
  });
});
