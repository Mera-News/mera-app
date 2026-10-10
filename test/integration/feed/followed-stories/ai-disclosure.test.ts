// Seam: the Stories page's state hook (useTrackedStoriesScreen) over the live followed-story
// list, on the in-memory DB. Its `aiNote` is the one AI line under the rows (EU AI Act Art. 50).
import { initI18nEn } from '@/test/helpers';
import { renderHook, waitFor } from '@testing-library/react-native';
import i18n from '@/lib/i18n';
import { useTrackedStoriesScreen } from '@/components/custom/tracked-stories/useTrackedStoriesScreen';
import { trackStory } from '@/lib/database/services/tracked-story-service';

const ALL = () => i18n.t('aiDisclosure.allStoryTitles');
const SOME = () => i18n.t('aiDisclosure.listNote');

async function follow(id: string, fields: { llmHeadline?: string; topicText?: string }) {
  await trackStory({
    articleId: `article-${id}`,
    title: `Followed from article ${id}`,
    originSurface: 'detail',
    topicText: fields.topicText ?? null,
    llmHeadline: fields.llmHeadline ?? null,
  });
}

async function noteFor(count: number) {
  const { result } = renderHook(() => useTrackedStoriesScreen());
  await waitFor(() => expect(result.current.stories).toHaveLength(count));
  return result.current.aiNote;
}

beforeEach(async () => {
  await initI18nEn();
});

describe('the AI line under followed stories', () => {
  it('says every title is AI-written when every story has Mera\'s headline', async () => {
    await follow('a', { llmHeadline: 'Harbour bridge repairs' });
    await follow('b', { llmHeadline: 'Night tram pilot' });
    expect(await noteFor(2)).toBe(ALL());
  });

  it('says only some are when a legacy story still shows its own title', async () => {
    await follow('a', { llmHeadline: 'Harbour bridge repairs' });
    await follow('legacy', {});
    expect(await noteFor(2)).toBe(SOME());
  });

  it('shows no line with no AI-written title at all', async () => {
    await follow('legacy', {});
    expect(await noteFor(1)).toBeNull();
  });

  // FD5 (owner ruling): a story's topic text is AI-written too. Each row already labels a
  // topic-titled story "AI-generated" (TrackedStoriesScreen renderItem: llmHeadline ?? topicText),
  // but the list line counts llmHeadline only (useTrackedStoriesScreen, llmCount), so the two
  // disagree on the same screen.
  describe('stories titled by their topic text', () => {
    async function topicTitledNote() {
      await follow('a', { topicText: 'Harbour bridge repairs in Fixtureville' });
      await follow('b', { topicText: 'Night tram pilot' });
      return noteFor(2);
    }

    test('count as AI-written titles in the list line, as each row already says', async () => {
      expect(await topicTitledNote()).toBe(ALL());
    });
  });
});
