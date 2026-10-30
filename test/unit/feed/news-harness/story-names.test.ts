import { buildStoryNamesPrompt, parseStoryNamesOutput } from '@/lib/news-harness/story-names';

describe('buildStoryNamesPrompt', () => {
  it('carries the decided rule and the label and search', () => {
    const { system, user } = buildStoryNamesPrompt({ label: 'Named Summit', search: 'Named Summit conference' });
    expect(system).toContain(
      '1-3 distinctive names (event, organisation, product or person) that any article about exactly this story must mention, written as English headlines write them: Latin script, no year, spelling variants in the spare slots.',
    );
    expect(system).toContain('Never a city, region or country on its own: a place name alone lets in every other event held there.');
    expect(system).toContain('Empty for a broad story that no single name covers.');
    expect(user).toContain('Story label: Named Summit');
    expect(user).toContain('Search: Named Summit conference');
  });
});

describe('parseStoryNamesOutput', () => {
  it('reads the last object with a mustMatch array, normalized', () => {
    expect(parseStoryNamesOutput('draft {"mustMatch":["Wrong"]} then ```json\n{"mustMatch":[" Named Summit ","named summit","NS"]}\n```')).toEqual([
      'Named Summit',
    ]);
  });

  it('an empty list is a valid answer', () => {
    expect(parseStoryNamesOutput('{"mustMatch": []}')).toEqual([]);
  });

  it('throws when there is no mustMatch object', () => {
    expect(() => parseStoryNamesOutput('no names here')).toThrow();
    expect(() => parseStoryNamesOutput('{"names":["A B C"]}')).toThrow();
  });
});
