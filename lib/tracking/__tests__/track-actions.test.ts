// track-actions unit tests — the follow flow's helper. Every collaborator
// (tracked-story service, ArticleService, inference queue/job service,
// mera-protocol store) is mocked so we assert ONLY the orchestration:
//   - the local row is created synchronously from the subject,
//   - enrichment resolves a stable id + seeds members,
//   - the headline job is enqueued (deduped) on-device / run inline on cloud,
//   - the archive-null path falls back to the live cluster.

jest.mock('../../database/services/tracked-story-service', () => ({
  trackStory: jest.fn(),
  untrackStory: jest.fn(),
  isTracked: jest.fn(),
  resolveStableId: jest.fn(),
  seedMembers: jest.fn(),
  findActiveTrackedId: jest.fn(),
  getTrackedStoryById: jest.fn(),
}));

jest.mock('../../database/services/topic-service', () => ({
  createTopics: jest.fn(),
  retire: jest.fn(),
}));

jest.mock('../../article-service', () => ({
  ArticleService: {
    trackStory: jest.fn(),
    getNewsClusterForArticle: jest.fn(),
    getTrackedStory: jest.fn(),
  },
}));

jest.mock('../../database/services/inference-job-service', () => ({
  enqueueJob: jest.fn(),
  hasPendingJob: jest.fn(),
}));

jest.mock('../../inference/handlers/story-headline-handler', () => ({
  handleStoryHeadlineJob: jest.fn(),
}));

jest.mock('../../inference/InferenceQueue', () => ({
  inferenceQueue: { notify: jest.fn() },
}));

const mockProcessingMode = { value: 'ON_DEVICE' as string };
jest.mock('../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: () => ({ processingMode: mockProcessingMode.value }),
  },
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { ArticleService } from '../../article-service';
import {
  trackStory,
  untrackStory,
  isTracked,
  resolveStableId,
  seedMembers,
  findActiveTrackedId,
  getTrackedStoryById,
} from '../../database/services/tracked-story-service';
import { createTopics, retire } from '../../database/services/topic-service';
import { enqueueJob, hasPendingJob } from '../../database/services/inference-job-service';
import { handleStoryHeadlineJob } from '../../inference/handlers/story-headline-handler';
import { inferenceQueue } from '../../inference/InferenceQueue';
import {
  trackStoryFromSubject,
  trackStoryWithProposal,
  untrackStoryFromSubject,
  isSubjectTracked,
  __test,
} from '../track-actions';
import type { FeedbackSubject } from '../../../components/custom/cards/feedback-subject';

const asMock = (fn: unknown) => fn as jest.Mock;

const SUBJECT: FeedbackSubject = {
  origin: 'suggestion',
  surface: 'for_you',
  articleId: 'art-1',
  suggestionId: 'sug-1',
  title: 'A developing story',
  stableClusterId: 'clu-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockProcessingMode.value = 'ON_DEVICE';
  asMock(trackStory).mockResolvedValue({ id: 'row-1' });
  asMock(hasPendingJob).mockResolvedValue(false);
  asMock(handleStoryHeadlineJob).mockResolvedValue({ ok: true });
  asMock(createTopics).mockResolvedValue([{ id: 'top-1' }]);
  asMock(getTrackedStoryById).mockResolvedValue(null);
});

describe('trackStoryFromSubject', () => {
  it('creates the local row instantly from the subject', async () => {
    await trackStoryFromSubject(SUBJECT);
    expect(trackStory).toHaveBeenCalledWith({
      stableClusterId: 'clu-1',
      articleId: 'art-1',
      title: 'A developing story',
      originSurface: 'for_you',
    });
  });
});

describe('enrichTrackedStory — archive path', () => {
  it('seeds members from the archive and enqueues a deduped headline job', async () => {
    asMock(ArticleService.trackStory).mockResolvedValue({
      stableClusterId: 'clu-1',
      articles: [
        { articleId: 'art-1', title_en: 'Title one' },
        { articleId: 'art-2', title_en: 'Title two' },
      ],
    });

    await __test.enrichTrackedStory('row-1', SUBJECT);

    expect(ArticleService.trackStory).toHaveBeenCalledWith('clu-1');
    // Members seeded (NOT via applyUpdates — no unseen bump at track time).
    expect(seedMembers).toHaveBeenCalledWith(
      'row-1',
      ['art-1', 'art-2'],
      expect.objectContaining({ latestArticleId: 'art-1' }),
    );
    // On-device: deduped enqueue + queue wake.
    expect(hasPendingJob).toHaveBeenCalledWith('story_headline', 'trackedStoryId', 'row-1');
    expect(enqueueJob).toHaveBeenCalledWith(
      'story_headline',
      expect.objectContaining({ trackedStoryId: 'row-1', titles: ['Title one', 'Title two'] }),
    );
    expect(inferenceQueue.notify).toHaveBeenCalled();
    expect(handleStoryHeadlineJob).not.toHaveBeenCalled();
  });

  it('skips the enqueue when a headline job is already pending (dedupe)', async () => {
    asMock(ArticleService.trackStory).mockResolvedValue({
      stableClusterId: 'clu-1',
      articles: [{ articleId: 'art-1', title_en: 'Title one' }],
    });
    asMock(hasPendingJob).mockResolvedValue(true);

    await __test.enrichTrackedStory('row-1', SUBJECT);

    expect(enqueueJob).not.toHaveBeenCalled();
    expect(inferenceQueue.notify).not.toHaveBeenCalled();
  });

  it('runs the headline handler inline in cloud mode', async () => {
    mockProcessingMode.value = 'CLOUD';
    asMock(ArticleService.trackStory).mockResolvedValue({
      stableClusterId: 'clu-1',
      articles: [{ articleId: 'art-1', title_en: 'Title one' }],
    });

    await __test.enrichTrackedStory('row-1', SUBJECT);

    expect(handleStoryHeadlineJob).toHaveBeenCalledWith(
      expect.objectContaining({ trackedStoryId: 'row-1', titles: ['Title one'], useCloud: true }),
    );
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe('enrichTrackedStory — archive-null fallback', () => {
  it('resolves the stable id from the live cluster when no archive exists', async () => {
    // No archive to seed from.
    asMock(ArticleService.trackStory)
      .mockResolvedValueOnce(null) // initial stableClusterId lookup
      .mockResolvedValueOnce({
        // second call: archive the resolved cluster
        stableClusterId: 'clu-live',
        articles: [{ articleId: 'art-1', title_en: 'Live title' }],
      });
    asMock(ArticleService.getNewsClusterForArticle).mockResolvedValue({
      stableClusterId: 'clu-live',
      articles: {
        articles: [
          { _id: 'art-1', title_en_internal_only: 'Live title' },
          { _id: 'art-9', title: 'Sibling' },
        ],
      },
    });

    await __test.enrichTrackedStory('row-1', SUBJECT);

    expect(ArticleService.getNewsClusterForArticle).toHaveBeenCalledWith('art-1');
    expect(resolveStableId).toHaveBeenCalledWith('row-1', 'clu-live');
    expect(seedMembers).toHaveBeenCalledWith('row-1', ['art-1'], expect.anything());
    expect(enqueueJob).toHaveBeenCalled();
  });

  it('falls back to the tapped title when no server coverage resolves', async () => {
    asMock(ArticleService.trackStory).mockResolvedValue(null);
    asMock(ArticleService.getNewsClusterForArticle).mockResolvedValue(null);

    await __test.enrichTrackedStory('row-1', {
      ...SUBJECT,
      stableClusterId: undefined,
    });

    // No stable id anywhere → no seed, headline built from the subject title.
    expect(seedMembers).not.toHaveBeenCalled();
    expect(enqueueJob).toHaveBeenCalledWith(
      'story_headline',
      expect.objectContaining({ titles: ['A developing story'] }),
    );
  });
});

describe('trackStoryWithProposal', () => {
  it('mints a tracked topic and creates the story with headline + snapshot', async () => {
    await trackStoryWithProposal(SUBJECT, '  Updates on the protest  ');

    expect(createTopics).toHaveBeenCalledWith([
      expect.objectContaining({
        text: 'Updates on the protest',
        status: 'active',
        provenance: 'tracked',
        highPriority: true,
        weight: 0.85,
      }),
    ]);
    expect(trackStory).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: 'art-1',
        topicId: 'top-1',
        topicText: 'Updates on the protest',
        llmHeadline: 'Updates on the protest',
        initialSnapshot: expect.objectContaining({ articleId: 'art-1' }),
      }),
    );
  });

  it('does not enqueue a separate headline job (headline is the proposal)', async () => {
    asMock(ArticleService.trackStory).mockResolvedValue({
      stableClusterId: 'clu-1',
      articles: [{ articleId: 'art-1', title_en: 'Title one' }],
    });
    await trackStoryWithProposal(SUBJECT, 'Track this topic');
    // Enrichment still runs for backfill, but skips the headline job.
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(handleStoryHeadlineJob).not.toHaveBeenCalled();
  });

  it('no-ops on a blank proposal', async () => {
    await trackStoryWithProposal(SUBJECT, '   ');
    expect(createTopics).not.toHaveBeenCalled();
    expect(trackStory).not.toHaveBeenCalled();
  });
});

describe('untrackStoryFromSubject / isSubjectTracked', () => {
  it('untracks the matched active row', async () => {
    asMock(findActiveTrackedId).mockResolvedValue('row-7');
    await untrackStoryFromSubject(SUBJECT);
    expect(untrackStory).toHaveBeenCalledWith('row-7');
  });

  it('retires the minted topic before untracking a topic-linked story', async () => {
    asMock(findActiveTrackedId).mockResolvedValue('row-7');
    asMock(getTrackedStoryById).mockResolvedValue({ id: 'row-7', topicId: 'top-9' });
    await untrackStoryFromSubject(SUBJECT);
    expect(retire).toHaveBeenCalledWith('top-9');
    expect(untrackStory).toHaveBeenCalledWith('row-7');
  });

  it('no-ops when nothing matches', async () => {
    asMock(findActiveTrackedId).mockResolvedValue(null);
    await untrackStoryFromSubject(SUBJECT);
    expect(untrackStory).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });

  it('delegates isSubjectTracked to the service', async () => {
    asMock(isTracked).mockResolvedValue(true);
    await expect(isSubjectTracked(SUBJECT)).resolves.toBe(true);
    expect(isTracked).toHaveBeenCalledWith({ stableClusterId: 'clu-1', articleId: 'art-1' });
  });
});
