
import { getTrackedStoryById, trackStory } from '@/lib/database/services/tracked-story-service';
import { handleTrackedStoryMigrateJob } from '@/lib/inference/handlers/tracked-story-migrate-handler';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { installLlama, resetFileSystem } from '@/test/integration/chat/_helpers';
import { cleanup, driveDone, prepare, setMode } from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

beforeEach(async () => {
  resetFileSystem();
  await disposeModel();
  useMeraProtocolStore.getState().setModelState('downloaded');
  installLlama([]); // Kev on disk; the text runs on the built-in model
  installOnDeviceLlm(); // a clean call log: onDeviceLlmCalls() counts this test's calls only
  await prepare();
});
afterEach(cleanup);

const TITLES = ['Floods hit Assam', 'Assam floods displace thousands'];
const legacyStory = () => trackStory({ articleId: 'a1', title: 'Floods hit Assam', originSurface: 'feed' });

describe('tracked_story_migrate', () => {
  const unmigrated = async (story: { id: string }) => {
    const row = await getTrackedStoryById(story.id);
    return { topicId: row?.topicId ?? null, topicText: row?.topicText ?? null, headline: row?.llmHeadline ?? null };
  };

  it('on-device: output that never fits the schema is retried once, then the story stays legacy', async () => {
    const story = await legacyStory();
    await setMode('on-device');
    installOnDeviceLlm({ reply: 'sorry, I cannot help with that' });

    const out = await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: story.id, titles: TITLES }));

    expect(out).toEqual({ ok: false });
    expect(onDeviceLlmCalls()).toHaveLength(2);
    expect(await unmigrated(story)).toEqual({ topicId: null, topicText: null, headline: null });
  });
});
