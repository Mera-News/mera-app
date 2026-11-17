// SuggestionSyncService: the scoring pass, and the throttled refresh that puts stored suggestions
// into the For You store.
//
// Real stores, real article_suggestions on the in-memory DB, real scoring pipeline and gateway
// mock in cloud mode, real local scoring over a faked llama.rn context in on-device mode. Only the
// native edges are mocked: llama.rn, expo-file-system (the model file), expo-keep-awake, the logger.
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import {
  __resetSuggestionsRefreshThrottleForTests,
  runScoringPass,
} from '@/lib/services/SuggestionSyncService';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useHardFilterLabelStore } from '@/lib/stores/hard-filter-label-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import {
  advanceUntilDone,
  useFakeClock,
} from '@/test/helpers';
import { resetFileSystem } from '@/test/helpers/fs';
import { installLlama, llamaCalls, llamaLoads, llamaMaxLive } from '@/test/helpers/llama';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { initLlama } from 'llama.rn';
import {
  quietLogger,
  resetForYouStore,
  seedArticles,
  seedFactWithTopic,
  settleWrites,
} from './seed';

// The edges: llama.rn (Kev, scripted by installLlama), the built-in model (the notes), expo-file-system
// (the model file), expo-keep-awake.
jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(),
}));

const mockInitLlama = initLlama as unknown as jest.Mock;

/** Six stories with nothing in common, so story grouping elects each as its own representative
 *  and the batch clears the cloud dispatch floor. */
const TITLES = [
  'Volcano erupts near Naples',
  'Central bank holds rates steady',
  'Local team wins cup final',
  'Chipmaker unveils quantum processor',
  'Floods displace thousands in Assam',
  'New museum opens in Lagos',
];
async function seedScorableStories() {
  const fact = await seedFactWithTopic('I follow chips', 'chips');
  await seedArticles(
    TITLES.map((title, i) => ({
      id: `a${i}`,
      title,
      matchedTopics: [{ topicId: fact.topicId, text: fact.topicText }],
    })),
  );
}

describe('SuggestionSyncService', () => {
  let logs: ReturnType<typeof quietLogger>;

  beforeEach(() => {
    logs = quietLogger();
    __resetSuggestionsRefreshThrottleForTests();
    resetForYouStore();
    useHardFilterLabelStore.getState().clear();
    useMeraProtocolStore.setState({
      processingMode: ProcessingMode.Cloud,
      modelState: 'not_downloaded',
    });
  });

  afterEach(async () => {
    // Runs before the harness's own afterEach: let fire-and-forget writes (setCounts persists feed
    // metadata) land before the clock and the DB are reset under them.
    await settleWrites();
    __resetSuggestionsRefreshThrottleForTests();
    pipeline._resetForTests();
    await disposeModel();
    useNetworkStore.setState({ isConnected: true });
    useMeraProtocolStore.setState({
      processingMode: ProcessingMode.Cloud,
      modelState: 'not_downloaded',
    });
    logs.restore();
  });

  describe('runScoringPass: on-device mode', () => {
    beforeEach(() => {
      useFakeClock('2026-10-09T09:00:00Z');
      resetFileSystem();
      installLlama([]);
      installOnDeviceLlm({ reply: 'A short note.' });
      useMeraProtocolStore.setState({
        processingMode: ProcessingMode.OnDevice,
        modelState: 'ready',
      });
    });

    it('does not preload a model: nothing to score loads nothing and leaves the model state alone', async () => {
      useMeraProtocolStore.setState({ modelState: 'downloaded' });

      await advanceUntilDone(runScoringPass());

      expect(mockInitLlama).not.toHaveBeenCalled();
      expect(useMeraProtocolStore.getState().modelState).toBe('downloaded');
    });

    it('loads Kev once per sync for scoring; the notes run on the built-in model, never on llama.rn', async () => {
      await seedScorableStories();

      await advanceUntilDone(runScoringPass(2));

      expect(llamaLoads()).toEqual([RELEVANCE_MODEL.modelId]);
      expect(llamaMaxLive()).toBe(1);
      expect(llamaCalls()).toHaveLength(0);
      expect(onDeviceLlmCalls().length).toBeGreaterThan(0);
    });

    it('does not load the model when it is already ready and there is nothing to score', async () => {
      await advanceUntilDone(runScoringPass());

      expect(mockInitLlama).not.toHaveBeenCalled();
    });
  });
});
