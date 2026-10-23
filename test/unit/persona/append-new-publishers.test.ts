import { appendNewPublishers } from '@/lib/algorithms/append-new-publishers';

const p = (_id: string) => ({ _id });

describe('appendNewPublishers', () => {
  it('drops rows already listed so the list never carries two rows with one key', () => {
    const out = appendNewPublishers([p('a'), p('b')], [p('b'), p('c')]);
    expect(out.map((x) => x._id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a repeat inside the incoming page too', () => {
    expect(appendNewPublishers([], [p('a'), p('a')]).map((x) => x._id)).toEqual(['a']);
  });
});
