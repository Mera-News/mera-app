// The Saved page's Group by: pure, over hand-built saved items.
import { groupSavedItems, parseGroupBy } from '@/components/custom/saved-suggestions/saved-groups';
import type { SavedItem } from '@/lib/database/services/saved-article-suggestion-service';

const suggestion = (id: string, relevance: number, topics: string[] = []): SavedItem =>
  ({
    origin: 'suggestion',
    savedAt: 0,
    list: 'later',
    suggestion: { _id: id, relevance, userTopicIds: topics },
  }) as unknown as SavedItem;

const article = (id: string): SavedItem =>
  ({ origin: 'article', savedId: id, savedAt: 0, list: 'later', article: { _id: id } }) as unknown as SavedItem;

const ids = (items: SavedItem[]) => items.map((i) => (i.origin === 'article' ? i.savedId : i.suggestion._id));
const shape = (groups: ReturnType<typeof groupSavedItems>) => groups.map((g) => [g.key, ids(g.items)]);

const fact = (id: string, statement: string, topics: string[]) => ({ id, statement, metadata: { topics } });

describe('parseGroupBy', () => {
  it('reads a stored choice and falls back to date saved', () => {
    expect(parseGroupBy('facts')).toBe('facts');
    expect(parseGroupBy('priority')).toBe('priority');
    expect(parseGroupBy(null)).toBe('newest');
    expect(parseGroupBy('nonsense')).toBe('newest');
  });
});

describe('groupSavedItems', () => {
  it('an empty list has no groups in any mode, so no heading shows', () => {
    for (const mode of ['newest', 'facts', 'priority'] as const) expect(groupSavedItems([], mode, [])).toEqual([]);
  });

  it('newest is one flat group in the given order', () => {
    const groups = groupSavedItems([suggestion('a', 0.9), article('b')], 'newest', []);
    expect(shape(groups)).toEqual([['all', ['a', 'b']]]);
    expect(groups[0].heading).toBeNull();
  });

  it('priority runs highest first, omits empty bands and keeps order inside', () => {
    const groups = groupSavedItems(
      [suggestion('low', 0.45), suggestion('high-1', 0.85), suggestion('med', 0.65), suggestion('high-2', 0.8)],
      'priority',
      [],
    );
    expect(shape(groups)).toEqual([
      ['band:HIGH', ['high-1', 'high-2']],
      ['band:MEDIUM', ['med']],
      ['band:LOW', ['low']],
    ]);
  });

  it('a story under the gate and a standalone save have no priority, and come last', () => {
    const groups = groupSavedItems([article('s'), suggestion('sub', 0.1), suggestion('high', 0.9)], 'priority', []);
    expect(shape(groups)).toEqual([
      ['band:HIGH', ['high']],
      ['no-priority', ['s', 'sub']],
    ]);
  });

  it('a multi-fact article appears once, under the fact holding most of its topics', () => {
    const facts = [fact('f1', 'Lives in Berlin', ['berlin']), fact('f2', 'Works in energy', ['energy', 'grid'])];
    const groups = groupSavedItems([suggestion('a', 0.7, ['berlin', 'energy', 'grid'])], 'facts', facts);
    expect(shape(groups)).toEqual([['fact:f2', ['a']]]);
    expect(groups[0].heading).toEqual({ kind: 'fact', statement: 'Works in energy' });
  });

  it('a fact title is the first of a joined statement', () => {
    const groups = groupSavedItems(
      [suggestion('a', 0.7, ['berlin'])],
      'facts',
      [fact('f1', 'Lives in Berlin; rides a bike', ['berlin'])],
    );
    expect(groups[0].heading).toEqual({ kind: 'fact', statement: 'Lives in Berlin' });
  });

  it('a save no fact holds goes to Other, last: a deleted fact, no topics, a standalone save', () => {
    const facts = [fact('f1', 'Lives in Berlin', ['berlin'])];
    const groups = groupSavedItems(
      [suggestion('gone', 0.7, ['deleted topic']), article('s'), suggestion('none', 0.7), suggestion('kept', 0.7, ['berlin'])],
      'facts',
      facts,
    );
    expect(shape(groups)).toEqual([
      ['fact:f1', ['kept']],
      ['other', ['gone', 's', 'none']],
    ]);
  });

  it('fact groups run by their newest save', () => {
    const facts = [fact('old', 'Old fact', ['x']), fact('new', 'New fact', ['y'])];
    const groups = groupSavedItems(
      [suggestion('a', 0.7, ['y']), suggestion('b', 0.7, ['x']), suggestion('c', 0.7, ['y'])],
      'facts',
      facts,
    );
    expect(shape(groups)).toEqual([
      ['fact:new', ['a', 'c']],
      ['fact:old', ['b']],
    ]);
  });
});
