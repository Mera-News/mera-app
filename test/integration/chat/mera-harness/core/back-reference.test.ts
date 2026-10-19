// S1.5: the recent-conversation block's pure parts.
import {
  escapeRecent,
  pointsBack,
  renderRecentBlock,
  subjectsOf,
  withExchange,
} from '@/lib/mera-harness/core/back-reference';

describe('pointsBack', () => {
  it.each([
    'okay, I want to follow this',
    'add that to my interests',
    'my parents live there',
    'update my places with it',
    'voeg dat toe aan mijn interesses',
    'ajoute ça à mes centres d’intérêt',
    'मेरे माता-पिता वहाँ रहते हैं',
    'इसे फॉलो करो',
    'それを私の興味に追加して',
    '我想关注这个',
    '我想關注這個',
    'ติดตามเรื่องนี้ให้หน่อย',
    '그것을 관심사에 추가해 줘',
    'أضف هذا إلى اهتماماتي',
    'добавь это в мои интересы',
    'додай це до моїх інтересів',
    'aggiungi questo ai miei interessi',
    'tambahkan ini ke minat saya',
    'dodaj to do moich zainteresowań',
    'bunu ilgi alanlarıma ekle',
    'thêm cái này vào sở thích của tôi',
    'adicione isso aos meus interesses',
    'añade esto a mis intereses',
    'füge das dort hinzu',
  ])('"%s" points back', (m) => expect(pointsBack(m)).toBe(true));

  it.each([
    'I enjoy rowing on weekends',
    'I work as a nurse in Leiden',
    'ik woon in het centrum',
    'Stop showing me celebrity gossip',
    '私は看護師です',
    '我是一名护士',
    'ฉันเป็นพยาบาล',
    '저는 간호사입니다',
    'أعمل ممرضة',
    'Я работаю медсестрой',
  ])('"%s" does not', (m) => expect(pointsBack(m)).toBe(false));
});

describe('escapeRecent', () => {
  it('strips our own scaffolding tags, nested ones included, then escapes', () => {
    const out = escapeRecent('a <state>b</state> <<recent>recent> <function=save> c', 500);
    expect(out).not.toMatch(/<\s*(state|recent|function)/);
    expect(out).toContain('a');
    expect(out).toContain('c');
  });

  it('caps the text', () => {
    expect(escapeRecent('x'.repeat(2000), 900).length).toBe(900);
  });
});

describe('exchanges and subjects', () => {
  it('keeps the last two exchanges, oldest first', () => {
    let r = withExchange([], 'one', 'r1');
    r = withExchange(r, 'two', 'r2');
    r = withExchange(r, 'three', 'r3');
    expect(r.map((x) => x.user)).toEqual(['two', 'three']);
  });

  it('dedupes subjects case-insensitively and drops empties', () => {
    expect(subjectsOf(['Porto Santo', 'porto santo', '', null, 'Madeira'])).toEqual(['Porto Santo', 'Madeira']);
  });

  it('no block before the first exchange; the block names the last turn\'s subjects', () => {
    expect(renderRecentBlock([], [])).toBeNull();
    const block = renderRecentBlock([{ user: 'What is Porto Santo?', reply: 'An island.' }], ['Porto Santo island']) ?? '';
    expect(block.startsWith('<recent>')).toBe(true);
    expect(block).toContain('They said: What is Porto Santo?\nYou replied: An island.');
    expect(block).toContain('Last turn was about: Porto Santo island');
    expect(block.endsWith('</recent>')).toBe(true);
  });
});
