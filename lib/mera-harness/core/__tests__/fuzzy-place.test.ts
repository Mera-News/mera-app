import { foldPlace, userSaidPlace } from '../fuzzy-place';

describe('foldPlace', () => {
  it('folds case, accents, hyphens and a leading article', () => {
    expect(foldPlace('Nieuw-West')).toBe('nieuw west');
    expect(foldPlace('São  Paulo')).toBe('sao paulo');
    expect(foldPlace('The Netherlands')).toBe('netherlands');
  });
});

describe('userSaidPlace (ux2 D2 fuzzy district guard)', () => {
  const msg = 'I live in niew west Amsterdam';

  it('accepts the canonical spelling of an obvious typo', () => {
    expect(userSaidPlace('Nieuw-West', msg)).toBe(true);
  });

  it('accepts an exact mention', () => {
    expect(userSaidPlace('Amsterdam', msg)).toBe(true);
  });

  it('accepts a run-together form', () => {
    expect(userSaidPlace('Nieuw-West', 'I live in nieuwwest')).toBe(true);
  });

  it('rejects an invented district of similar length', () => {
    expect(userSaidPlace('Nieuw-Oost', msg)).toBe(false);
    expect(userSaidPlace('Noord', msg)).toBe(false);
    expect(userSaidPlace('Machico', 'my girlfriend\'s parents live in Porto Santo')).toBe(false);
  });

  it('gives short words no slack', () => {
    expect(userSaidPlace('Oss', 'I live in Ost')).toBe(false);
  });

  it('rejects an empty term', () => {
    expect(userSaidPlace('  ', msg)).toBe(false);
  });
});
