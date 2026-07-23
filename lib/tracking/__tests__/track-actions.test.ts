// track-actions unit tests — the follow flow's helper. Every collaborator
// (tracked-story service, topic service, inference queue) is mocked so we assert
// ONLY the orchestration:
//   - trackStoryWithProposal mints a topic from the accepted scope's search
//     text and creates the local row with the display label as headline,
//   - untrackStoryFromSubject retires the linked topic then untracks,
//   - isSubjectTracked delegates to the service,
//   - migrateLegacyTrackedStories routes each legacy row through the migrate
//     handler inline (cloud) or a deduped enqueued job (on-device).

jest.mock('../../database/services/tracked-story-service', () => ({
  trackStory: jest.fn(),
  untrackStory: jest.fn(),
  isTracked: jest.fn(),
  findActiveTrackedId: jest.fn(),
  getTrackedStoryById: jest.fn(),
  getLegacyTrackedForMigration: jest.fn(),
}));

jest.mock('../../database/services/topic-service', () => ({
  createTopics: jest.fn(),
  retire: jest.fn(),
}));

jest.mock('../../database/services/inference-job-service', () => ({
  enqueueJob: jest.fn(),
  hasPendingJob: jest.fn(),
}));

jest.mock('../../inference/handlers/tracked-story-migrate-handler', () => ({
  handleTrackedStoryMigrateJob: jest.fn(),
}));

jest.mock('../../inference/InferenceQueue', () => ({
  inferenceQueue: { notify: jest.fn() },
}));

jest.mock('../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: jest.fn() },
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import {
  trackStory,
  untrackStory,
  isTracked,
  findActiveTrackedId,
  getTrackedStoryById,
  getLegacyTrackedForMigration,
} from '../../database/services/tracked-story-service';
import { createTopics, retire } from '../../database/services/topic-service';
import { enqueueJob, hasPendingJob } from '../../database/services/inference-job-service';
import { handleTrackedStoryMigrateJob } from '../../inference/handlers/tracked-story-migrate-handler';
import { inferenceQueue } from '../../inference/InferenceQueue';
import { useMeraProtocolStore } from '../../stores/mera-protocol-store';
import { ProcessingMode } from '../../generated/graphql-types';
import {
  trackStoryWithProposal,
  untrackStoryFromSubject,
  isSubjectTracked,
  migrateLegacyTrackedStories,
  type AcceptedTrackScope,
} from '../track-actions';
import type { FeedbackSubject } from '../../../components/custom/cards/feedback-subject';

const asMock = (fn: unknown) => fn as jest.Mock;

const setProcessingMode = (mode: ProcessingMode) =>
  asMock(useMeraProtocolStore.getState).mockReturnValue({ processingMode: mode });

const SUBJECT: FeedbackSubject = {
  origin: 'suggestion',
  surface: 'for_you',
  articleId: 'art-1',
  suggestionId: 'sug-1',
  title: 'A developing story',
  stableClusterId: 'clu-1',
};

const SCOPE: AcceptedTrackScope = {
  label: 'Protest updates',
  searchText: 'Updates on the protest',
};

beforeEach(() => {
  jest.clearAllMocks();
  asMock(trackStory).mockResolvedValue({ id: 'row-1' });
  asMock(createTopics).mockResolvedValue([{ id: 'top-1' }]);
  asMock(getTrackedStoryById).mockResolvedValue(null);
  asMock(hasPendingJob).mockResolvedValue(false);
  asMock(enqueueJob).mockResolvedValue('job-1');
  asMock(handleTrackedStoryMigrateJob).mockResolvedValue({ ok: true });
  setProcessingMode(ProcessingMode.OnDevice);
});

describe('trackStoryWithProposal', () => {
  it('mints a tracked topic from the search text and creates the story row', async () => {
    await trackStoryWithProposal(SUBJECT, SCOPE);

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
        stableClusterId: 'clu-1',
        articleId: 'art-1',
        title: 'A developing story',
        originSurface: 'for_you',
        topicId: 'top-1',
        topicText: 'Updates on the protest',
        llmHeadline: 'Protest updates',
        initialSnapshot: expect.objectContaining({ articleId: 'art-1' }),
      }),
    );
  });

  it('falls back to the search text as the headline when label is blank', async () => {
    await trackStoryWithProposal(SUBJECT, { label: '  ', searchText: 'Updates on the protest' });

    expect(trackStory).toHaveBeenCalledWith(
      expect.objectContaining({ llmHeadline: 'Updates on the protest' }),
    );
  });

  it('stamps the subject real pubDate into the seed snapshot (Part E)', async () => {
    await trackStoryWithProposal({ ...SUBJECT, pubDate: '2026-07-15T09:30:00.000Z' }, SCOPE);
    expect(trackStory).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSnapshot: expect.objectContaining({
          articleId: 'art-1',
          pubDateMs: Date.parse('2026-07-15T09:30:00.000Z'),
        }),
      }),
    );
  });

  it('falls back to now for the seed snapshot pubDate when subject has none', async () => {
    const before = Date.now();
    await trackStoryWithProposal(SUBJECT, SCOPE);
    const call = asMock(trackStory).mock.calls.at(-1)?.[0];
    expect(call.initialSnapshot.pubDateMs).toBeGreaterThanOrEqual(before);
  });

  it('no-ops on a blank search text', async () => {
    await trackStoryWithProposal(SUBJECT, { label: 'Protest updates', searchText: '   ' });
    expect(createTopics).not.toHaveBeenCalled();
    expect(trackStory).not.toHaveBeenCalled();
  });

  it('still creates the row with a null topicId when the topic mint throws', async () => {
    asMock(createTopics).mockRejectedValue(new Error('mint failed'));

    await trackStoryWithProposal(SUBJECT, SCOPE);

    expect(trackStory).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: null, topicText: 'Updates on the protest' }),
    );
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

describe('migrateLegacyTrackedStories', () => {
  it('returns 0 and does nothing when there is nothing legacy to migrate', async () => {
    asMock(getLegacyTrackedForMigration).mockResolvedValue([]);

    await expect(migrateLegacyTrackedStories()).resolves.toBe(0);
    expect(handleTrackedStoryMigrateJob).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(inferenceQueue.notify).not.toHaveBeenCalled();
  });

  describe('CLOUD processing mode', () => {
    beforeEach(() => setProcessingMode(ProcessingMode.Cloud));

    it('runs the migrate handler inline per row and returns the ok count', async () => {
      asMock(getLegacyTrackedForMigration).mockResolvedValue([
        { id: 'row-1', titles: ['Title A', 'Title B'] },
        { id: 'row-2', titles: ['Title C'] },
      ]);

      const migrated = await migrateLegacyTrackedStories();

      expect(migrated).toBe(2);
      expect(handleTrackedStoryMigrateJob).toHaveBeenNthCalledWith(1, {
        trackedStoryId: 'row-1',
        titles: ['Title A', 'Title B'],
        useCloud: true,
      });
      expect(handleTrackedStoryMigrateJob).toHaveBeenNthCalledWith(2, {
        trackedStoryId: 'row-2',
        titles: ['Title C'],
        useCloud: true,
      });
      // Cloud path never touches the queue.
      expect(enqueueJob).not.toHaveBeenCalled();
      expect(inferenceQueue.notify).not.toHaveBeenCalled();
    });

    it('only counts rows the handler reports ok', async () => {
      asMock(getLegacyTrackedForMigration).mockResolvedValue([
        { id: 'row-1', titles: ['A'] },
        { id: 'row-2', titles: ['B'] },
      ]);
      asMock(handleTrackedStoryMigrateJob)
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true });

      await expect(migrateLegacyTrackedStories()).resolves.toBe(1);
    });

    it('continues past a per-row handler throw', async () => {
      asMock(getLegacyTrackedForMigration).mockResolvedValue([
        { id: 'row-1', titles: ['A'] },
        { id: 'row-2', titles: ['B'] },
      ]);
      asMock(handleTrackedStoryMigrateJob)
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ ok: true });

      await expect(migrateLegacyTrackedStories()).resolves.toBe(1);
    });
  });

  describe('ON-DEVICE processing mode', () => {
    beforeEach(() => setProcessingMode(ProcessingMode.OnDevice));

    it('enqueues a deduped migrate job per row and notifies the queue', async () => {
      asMock(getLegacyTrackedForMigration).mockResolvedValue([
        { id: 'row-1', titles: ['Title A', 'Title B'] },
        { id: 'row-2', titles: ['Title C'] },
      ]);

      const migrated = await migrateLegacyTrackedStories();

      expect(migrated).toBe(2);
      expect(handleTrackedStoryMigrateJob).not.toHaveBeenCalled();
      expect(enqueueJob).toHaveBeenNthCalledWith(1, 'tracked_story_migrate', {
        trackedStoryId: 'row-1',
        titles: ['Title A', 'Title B'],
      });
      expect(enqueueJob).toHaveBeenNthCalledWith(2, 'tracked_story_migrate', {
        trackedStoryId: 'row-2',
        titles: ['Title C'],
      });
      expect(inferenceQueue.notify).toHaveBeenCalledTimes(1);
    });

    it('skips rows that already have a pending job (dedupe)', async () => {
      asMock(getLegacyTrackedForMigration).mockResolvedValue([
        { id: 'row-1', titles: ['A'] },
        { id: 'row-2', titles: ['B'] },
      ]);
      asMock(hasPendingJob)
        .mockResolvedValueOnce(true) // row-1 already queued → skip
        .mockResolvedValueOnce(false); // row-2 → enqueue

      const migrated = await migrateLegacyTrackedStories();

      expect(migrated).toBe(1);
      expect(enqueueJob).toHaveBeenCalledTimes(1);
      expect(enqueueJob).toHaveBeenCalledWith('tracked_story_migrate', {
        trackedStoryId: 'row-2',
        titles: ['B'],
      });
      expect(inferenceQueue.notify).toHaveBeenCalledTimes(1);
    });

    it('does not notify when every row was deduped away', async () => {
      asMock(getLegacyTrackedForMigration).mockResolvedValue([
        { id: 'row-1', titles: ['A'] },
      ]);
      asMock(hasPendingJob).mockResolvedValue(true);

      const migrated = await migrateLegacyTrackedStories();

      expect(migrated).toBe(0);
      expect(enqueueJob).not.toHaveBeenCalled();
      expect(inferenceQueue.notify).not.toHaveBeenCalled();
    });

    it('continues past a per-row enqueue throw', async () => {
      asMock(getLegacyTrackedForMigration).mockResolvedValue([
        { id: 'row-1', titles: ['A'] },
        { id: 'row-2', titles: ['B'] },
      ]);
      asMock(enqueueJob)
        .mockRejectedValueOnce(new Error('db full'))
        .mockResolvedValueOnce('job-2');

      const migrated = await migrateLegacyTrackedStories();

      expect(migrated).toBe(1);
      expect(inferenceQueue.notify).toHaveBeenCalledTimes(1);
    });
  });
});
