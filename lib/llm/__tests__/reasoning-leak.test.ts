import { stripLeakedReasoning } from '../reasoning-leak';

describe('stripLeakedReasoning', () => {
  it('drops a closer-only prefix — the GLM 5.3 Flash thinking-off shape', () => {
    // Verbatim shape returned by z-ai/glm-5.3-flash with enable_thinking:false.
    expect(
      stripLeakedReasoning(
        'The user wants three European capitals, comma separated, nothing else. Terse response.</think>Paris, Berlin, Rome',
      ),
    ).toBe('Paris, Berlin, Rome');
  });

  it('removes well-formed think blocks', () => {
    expect(stripLeakedReasoning('<think>hmm</think>[{"k":"none","s":0.15}]')).toBe(
      '[{"k":"none","s":0.15}]',
    );
  });

  it('keeps only what follows the LAST closer when several appear', () => {
    expect(stripLeakedReasoning('a</think>b</think>answer')).toBe('answer');
  });

  it('returns clean text unchanged, including JSON and prose with angle brackets', () => {
    const json = '[{"k": "home", "s": 0.65}]';
    expect(stripLeakedReasoning(json)).toBe(json);
    const prose = 'Rising costs affect your Amsterdam home; think < 2% change.';
    expect(stripLeakedReasoning(prose)).toBe(prose);
    expect(stripLeakedReasoning('')).toBe('');
  });
});
