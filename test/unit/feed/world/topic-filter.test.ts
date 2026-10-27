import type { TFunction } from 'i18next';
import { effectivePick, topicLabel, topicSlug, visibleTopics } from '@/lib/explore/topic-filter';

const tp = (id: string, path: string, label = id) => ({ id, path, label, level: 1 });

it('slugs a path', () => {
    expect(topicSlug('/Arts & Entertainment')).toBe('arts_entertainment');
    expect(topicSlug('/Science')).toBe('science');
});

it('label falls back to the server label when no key exists', () => {
    const missing = ((key: string) => key) as unknown as TFunction;
    expect(topicLabel(missing, tp('a', '/Odd Topic', 'Odd'))).toBe('Odd');
    expect(topicLabel((() => 'Politik') as unknown as TFunction, tp('a', '/Politics'))).toBe('Politik');
});

it('visibleTopics drops excluded and zero counts and sorts by count', () => {
    const topics = [tp('a', '/A'), tp('b', '/B'), tp('r', '/Reference'), tp('z', '/Z')];
    const facets = [
        { topicId: 'a', count: 2 },
        { topicId: 'b', count: 9 },
        { topicId: 'r', count: 50 },
        { topicId: 'z', count: 0 },
    ];
    expect(visibleTopics(topics, facets).map((x) => x.topic.id)).toEqual(['b', 'a']);
});

it('effectivePick keeps a pick only with a positive count', () => {
    expect(effectivePick('a', [{ topicId: 'a', count: 1 }])).toBe('a');
    expect(effectivePick('a', [{ topicId: 'a', count: 0 }])).toBeNull();
    expect(effectivePick('a', [])).toBeNull();
    expect(effectivePick(null, [{ topicId: 'a', count: 1 }])).toBeNull();
});
