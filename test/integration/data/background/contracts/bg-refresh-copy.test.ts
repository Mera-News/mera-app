// The English copy of the Background refresh row, read as text from the locale file. Replaces the
// "the English copy" block of lib/background/__tests__/bg-refresh-ui.test.ts, which is a content
// check, not behaviour (T-home: contracts).
const frag = require('@/lib/locales/en.json') as { meraProtocol: Record<string, string> };

const KEYS = ['bgRefreshTitle', 'bgRefreshCloudIos', 'bgRefreshCloudAndroid', 'bgRefreshOnDevice'];

describe('the English copy of the Background refresh row', () => {
  it('covers every key the row can ask for', () => {
    for (const key of KEYS) expect(frag.meraProtocol[key]).toEqual(expect.any(String));
  });

  it('has no em or en dashes', () => {
    for (const key of KEYS) expect(frag.meraProtocol[key]).not.toMatch(/[–—]/);
  });
});
