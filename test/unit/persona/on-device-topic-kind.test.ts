// AFM reads the whole on-device topic rule block as one template, so an origin fact got the
// residence ladder and an interest borrowed the country subject list. The block is picked per
// fact kind in code, the way the cloud picks a topics/* guideline.
import { buildTopicGenPrompt, topicFactKind } from '@/lib/news-harness/on-device/topic-gen/prompt';

describe('topicFactKind', () => {
  it.each([
    ['Lives in Gràcia, Barcelona, Catalonia, Spain', 'residence'],
    ['Lives in Reykjavik, Iceland', 'residence'],
    ['Moved to Porto last year', 'residence'],
    ['Originally from Eritrea', 'origin'],
    ['Expat from the Philippines living in Dublin', 'origin'],
    ['Originally from Poland, now living in Rotterdam', 'origin'],
    ['Parents live in Bhopal', 'elsewhere'],
    ['Sister studies in Lyon', 'elsewhere'],
    ['Visiting Lisbon in March', 'elsewhere'],
    ['Works as a software engineer', 'field'],
    ['Works as a solicitor', 'field'],
    ['Plays chess', 'field'],
    ['Listens to drum and bass', 'field'],
    ['Supports Feyenoord', 'field'],
    ['Invests in index funds', 'field'],
  ])('%s -> %s', (statement, kind) => {
    expect(topicFactKind(statement)).toBe(kind);
  });

  it.each(['Expecting their first child', 'Works in Amsterdam', 'Vegetarian', ''])('no kind it can be sure of: %j', (statement) => {
    expect(topicFactKind(statement)).toBeNull();
  });
});

describe('buildTopicGenPrompt per kind', () => {
  const rules = (statement: string) => buildTopicGenPrompt({ factStatement: statement, excludeTopics: [] }, 5).prompt;
  const PLACE_LINES = ['widen one step at a time', 'stay at that exact place', 'citizens abroad', 'A country or a group of countries needs a subject'];
  const FIELD = 'Name concrete news in that field';

  it('an interest or a job gets only the field line, never the place rules', () => {
    for (const statement of ['Supports Feyenoord', 'Works as a nurse']) {
      const p = rules(statement);
      expect(p).toContain(FIELD);
      for (const line of PLACE_LINES) expect(p).not.toContain(line);
      // The rules that follow keep counting on from 2.
      expect(p).toMatch(/\n3\. Never use the words/);
    }
  });

  // Measured on AFM: alone, the origin line drew a refusal on 2 of 3 origin facts, and the
  // residence and someone-else lines dropped the place's own name. They keep the whole block.
  it.each(['Lives in Reykjavik, Iceland', 'Originally from Eritrea', 'Parents live in Bhopal', 'Expecting their first child'])(
    'a place fact or an unknown one keeps every rule: %s',
    (statement) => {
      const p = rules(statement);
      for (const line of [...PLACE_LINES, FIELD]) expect(p).toContain(line);
      expect(p).toMatch(/\n4\. Never use the words/);
    },
  );
});
