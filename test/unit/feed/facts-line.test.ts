import { factsLine, titleCaseWords } from '@/lib/algorithms/facts-line';

describe('titleCaseWords', () => {
  it.each([
    ['Expat in The Netherlands', 'Expat In The Netherlands'],
    ['Interested in local language models', 'Interested In Local Language Models'],
    ['Entrepreneur building an AI-curated news app startup', 'Entrepreneur Building An AI-curated News App Startup'],
    ['I am interested in FC Chelsea', 'I Am Interested In FC Chelsea'],
    ['interested in F1', 'Interested In F1'],
    ['Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU', 'Lives In Nieuw-West, Amsterdam, North Holland, The Netherlands, EU'],
    ['élève à Paris', 'Élève À Paris'],
    ['मुंबई में रहता है', 'मुंबई में रहता है'],
  ])('%p -> %p', (input, out) => {
    expect(titleCaseWords(input)).toBe(out);
  });
});

describe('factsLine', () => {
  it('joins facts with a middle dot so commas inside a fact stay readable', () => {
    expect(factsLine(['Expat in The Netherlands', 'Lives in Nieuw-West, Amsterdam, EU'])).toBe(
      'Expat In The Netherlands · Lives In Nieuw-West, Amsterdam, EU',
    );
  });

  it('drops blanks and repeats', () => {
    expect(factsLine(['From India', '  ', 'from India', 'From India'])).toBe('From India');
  });

  it('is empty for no facts', () => {
    expect(factsLine([])).toBe('');
  });
});
