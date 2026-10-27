// Re-persisting an existing row heals a null story_key, write-once: a non-null key is never replaced.
import { seedUnscored, suggestionRow } from './seed';

describe('persist story_key heal', () => {
  it('fills a null key when the article now carries one, and a second different key does not overwrite it', async () => {
    await seedUnscored({ id: 'a1', storyKey: null });
    expect((await suggestionRow('a1')).storyKey).toBeNull();

    await seedUnscored({ id: 'a1', storyKey: 'key-1' });
    expect((await suggestionRow('a1')).storyKey).toBe('key-1');

    await seedUnscored({ id: 'a1', storyKey: 'key-2' });
    expect((await suggestionRow('a1')).storyKey).toBe('key-1');
  });
});
