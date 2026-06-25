// SuggestionSyncService.test.ts

const mockLoadSuggestions = jest.fn();
const mockGetUnscoredSuggestionsWithFacts = jest.fn();
const mockSaveScoringResult = jest.fn();
const mockInitBaseModel = jest.fn();
const mockProcessAllUnscored = jest.fn();
const mockRunBackgroundCycle = jest.fn();
const mockActivateKeepAwakeAsync = jest.fn();
const mockDeactivateKeepAwake = jest.fn();
const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();

// For-You store mock
const mockForYouState = {
  startDeviceProcessing: jest.fn(),
  updateDeviceProgress: jest.fn(),
  finishDeviceProcessing: jest.fn(),
  markProcessingRunFinished: jest.fn(),
  setCounts: jest.fn(),
  setScoringError: jest.fn(),
  setState: jest.fn(),
  articleCount: 5,
  relevantArticleCount: 2,
};

// MeraProtocol store mock
const mockMeraProtocolState = {
  processingMode: 'CLOUD',
  modelState: 'ready',
  setModelState: jest.fn(),
};

// OnDeviceBanner store mock
const mockOnDeviceBannerState = {
  show: jest.fn(),
  hide: jest.fn(),
};

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  loadSuggestions: (...args: any[]) => mockLoadSuggestions(...args),
  getUnscoredSuggestionsWithFacts: (...args: any[]) => mockGetUnscoredSuggestionsWithFacts(...args),
  saveScoringResult: (...args: any[]) => mockSaveScoringResult(...args),
}));

jest.mock('@/lib/services/scoring-error', () => ({
  classifyScoringError: () => 'server',
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    captureException: (...args: any[]) => mockCaptureException(...args),
    captureMessage: (...args: any[]) => mockCaptureMessage(...args),
  },
}));

jest.mock('@/lib/mera-protocol-toolkit', () => ({
  initBaseModel: (...args: any[]) => mockInitBaseModel(...args),
}));

jest.mock('@/lib/mera-protocol/scoring-service', () => ({
  processAllUnscored: (...args: any[]) => mockProcessAllUnscored(...args),
}));

jest.mock('@/lib/background/run-inference-handler', () => ({
  runBackgroundCycle: (...args: any[]) => mockRunBackgroundCycle(...args),
}));

jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: {
    getState: jest.fn(() => mockForYouState),
    setState: jest.fn((updates: any) => {
      Object.assign(mockForYouState, updates);
    }),
  },
}));

jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: jest.fn(() => mockMeraProtocolState),
  },
}));

jest.mock('@/lib/generated/graphql-types', () => ({
  ProcessingMode: { OnDevice: 'ON_DEVICE', Cloud: 'CLOUD' },
}));

jest.mock('@/lib/stores/on-device-banner-store', () => ({
  useOnDeviceBannerStore: {
    getState: jest.fn(() => mockOnDeviceBannerState),
  },
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: (...args: any[]) => mockActivateKeepAwakeAsync(...args),
  deactivateKeepAwake: (...args: any[]) => mockDeactivateKeepAwake(...args),
}));

import { runScoringPass, refreshSuggestionsInStoreUnsafe } from '../SuggestionSyncService';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';

describe('runScoringPass', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockActivateKeepAwakeAsync.mockResolvedValue(undefined);
    mockDeactivateKeepAwake.mockReturnValue(undefined);
    mockForYouState.articleCount = 5;
    mockForYouState.relevantArticleCount = 2;
  });

  describe('cloud mode (non on-device)', () => {
    beforeEach(() => {
      mockMeraProtocolState.processingMode = 'CLOUD';
    });

    it('calls runBackgroundCycle in cloud mode and returns 0', async () => {
      mockRunBackgroundCycle.mockResolvedValue('submitted');

      const result = await runScoringPass();

      expect(mockRunBackgroundCycle).toHaveBeenCalledWith('scoring-pass');
      expect(result).toBe(0);
    });

    it('clears the header scoring error when the cycle reaches the gateway', async () => {
      mockRunBackgroundCycle.mockResolvedValue('submitted');

      await runScoringPass();

      expect(mockForYouState.setScoringError).toHaveBeenCalledWith(null);
    });

    it('sets the header scoring error on error result', async () => {
      mockRunBackgroundCycle.mockResolvedValue('error');

      await runScoringPass();

      expect(mockForYouState.setScoringError).toHaveBeenCalledWith('server');
    });

    it('does not set or clear the header error on neutral outcomes (skipped-pending)', async () => {
      mockRunBackgroundCycle.mockResolvedValue('skipped-pending');

      await runScoringPass();

      expect(mockForYouState.setScoringError).not.toHaveBeenCalled();
    });

    it('logs warning and returns 0 when skipped-no-token', async () => {
      mockRunBackgroundCycle.mockResolvedValue('skipped-no-token');

      const result = await runScoringPass();

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        expect.stringContaining('cloud scoring skipped'),
        expect.any(Object),
      );
      expect(result).toBe(0);
    });

    it('logs warning and returns 0 when error result', async () => {
      mockRunBackgroundCycle.mockResolvedValue('error');

      const result = await runScoringPass();

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        expect.stringContaining('cloud inference cycle returned error'),
        expect.any(Object),
      );
      expect(result).toBe(0);
    });

    it('rethrows exceptions from runBackgroundCycle and sets the header error', async () => {
      const err = new Error('cycle error');
      mockRunBackgroundCycle.mockRejectedValue(err);

      await expect(runScoringPass()).rejects.toThrow('cycle error');
      expect(mockCaptureException).toHaveBeenCalledWith(err, expect.any(Object));
      expect(mockForYouState.setScoringError).toHaveBeenCalledWith('server');
    });
  });

  describe('on-device mode', () => {
    beforeEach(() => {
      mockMeraProtocolState.processingMode = 'ON_DEVICE';
      mockMeraProtocolState.modelState = 'ready';
      mockProcessAllUnscored.mockResolvedValue(5);
      mockLoadSuggestions.mockResolvedValue([]);
    });

    it('keeps the screen awake during on-device scoring', async () => {
      await runScoringPass();

      expect(mockActivateKeepAwakeAsync).toHaveBeenCalledWith('mera-scoring-pass');
      expect(mockDeactivateKeepAwake).toHaveBeenCalledWith('mera-scoring-pass');
    });

    it('shows and hides on-device banner', async () => {
      await runScoringPass();

      expect(mockOnDeviceBannerState.show).toHaveBeenCalled();
      expect(mockOnDeviceBannerState.hide).toHaveBeenCalled();
    });

    it('calls processAllUnscored with batchSize and returns count', async () => {
      mockProcessAllUnscored.mockResolvedValue(7);

      const result = await runScoringPass(10);

      expect(mockProcessAllUnscored).toHaveBeenCalledWith(
        expect.any(Function),
        10,
        expect.any(Function),
      );
      expect(result).toBe(7);
    });

    it('loads model when modelState is not ready', async () => {
      mockMeraProtocolState.modelState = 'idle';
      mockInitBaseModel.mockResolvedValue(undefined);

      await runScoringPass();

      expect(mockMeraProtocolState.setModelState).toHaveBeenCalledWith('loading');
      expect(mockInitBaseModel).toHaveBeenCalled();
      expect(mockMeraProtocolState.setModelState).toHaveBeenCalledWith('ready');
    });

    it('marks processing run finished when on-device succeeds', async () => {
      await runScoringPass();

      expect(mockForYouState.markProcessingRunFinished).toHaveBeenCalled();
    });

    it('calls finishDeviceProcessing in finally block even on error', async () => {
      const err = new Error('scoring failed');
      mockProcessAllUnscored.mockRejectedValue(err);

      await expect(runScoringPass()).rejects.toThrow('scoring failed');

      expect(mockForYouState.finishDeviceProcessing).toHaveBeenCalled();
      expect(mockOnDeviceBannerState.hide).toHaveBeenCalled();
      expect(mockDeactivateKeepAwake).toHaveBeenCalledWith('mera-scoring-pass');
    });

    it('captures exceptions on-device and rethrows', async () => {
      const err = new Error('on-device error');
      mockProcessAllUnscored.mockRejectedValue(err);

      await expect(runScoringPass()).rejects.toThrow('on-device error');

      expect(mockCaptureException).toHaveBeenCalledWith(err, expect.any(Object));
    });

    it('onBatchComplete callback refreshes suggestions without throwing', async () => {
      mockLoadSuggestions.mockResolvedValue([
        { relevance: 0.9, status: ArticleSuggestionStatus.ReasonPending },
      ]);

      let capturedOnBatchComplete: (() => void) | null = null;
      mockProcessAllUnscored.mockImplementation(async (_onProgress, _batchSize, onBatchComplete) => {
        capturedOnBatchComplete = onBatchComplete;
        return 3;
      });

      await runScoringPass();

      // Now invoke the captured callback
      if (capturedOnBatchComplete) {
        (capturedOnBatchComplete as (() => void))();
        // Allow async operations to complete
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });

    it('onBatchComplete catches and logs loadSuggestions errors via captureException', async () => {
      // Covers line 82: the .catch() path inside onBatchComplete when refreshSuggestionsInStore throws
      const loadErr = new Error('db read error');
      mockLoadSuggestions.mockRejectedValue(loadErr);

      let capturedOnBatchComplete: (() => void) | null = null;
      mockProcessAllUnscored.mockImplementation(async (_onProgress, _batchSize, onBatchComplete) => {
        capturedOnBatchComplete = onBatchComplete;
        return 2;
      });

      await runScoringPass();

      // Invoke the callback — it calls refreshSuggestionsInStore() which rejects
      (capturedOnBatchComplete as (() => void) | null)?.();
      // Let the rejected promise propagate through the .catch() callback
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(mockCaptureException).toHaveBeenCalledWith(
        loadErr,
        expect.objectContaining({
          tags: expect.objectContaining({ service: 'SuggestionSyncService' }),
        }),
      );
    });

    it('onProgress callback updates device progress via store (covers line 89)', async () => {
      // Covers line 89: onProgress calls updateDeviceProgress(completed, total)
      mockLoadSuggestions.mockResolvedValue([]);

      let capturedOnProgress: ((completed: number, total: number) => void) | null = null;
      mockProcessAllUnscored.mockImplementation(async (onProgress, _batchSize, _onBatchComplete) => {
        capturedOnProgress = onProgress;
        // Invoke the progress callback during scoring
        onProgress(3, 10);
        return 3;
      });

      await runScoringPass();

      expect(mockForYouState.updateDeviceProgress).toHaveBeenCalledWith(3, 10);
      expect(capturedOnProgress).not.toBeNull();
    });

    it('startDeviceProcessing is called with 0 before scoring begins', async () => {
      await runScoringPass();

      expect(mockForYouState.startDeviceProcessing).toHaveBeenCalledWith(0);
    });
  });
});

describe('refreshSuggestionsInStoreUnsafe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockForYouState.articleCount = 10;
    mockForYouState.relevantArticleCount = 3;
  });

  it('loads suggestions and updates store state', async () => {
    const suggestions = [
      { relevance: 0.9, status: ArticleSuggestionStatus.ReasonPending },
      { relevance: 0.1, status: ArticleSuggestionStatus.ReasonPending },
    ];
    mockLoadSuggestions.mockResolvedValue(suggestions);

    await refreshSuggestionsInStoreUnsafe();

    // Store should have been updated
    const { useForYouStore } = require('@/lib/stores/for-you-store');
    expect(useForYouStore.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestions: expect.any(Array),
      }),
    );
  });

  it('sorts suggestions by relevance descending (scored before unscored)', async () => {
    const suggestions = [
      { relevance: 0.3, status: ArticleSuggestionStatus.ReasonPending },
      { relevance: 0.9, status: ArticleSuggestionStatus.ReasonPending },
      { relevance: 0.0, status: ArticleSuggestionStatus.Unscored },
    ];
    mockLoadSuggestions.mockResolvedValue(suggestions);

    await refreshSuggestionsInStoreUnsafe();

    const { useForYouStore } = require('@/lib/stores/for-you-store');
    const callArg = useForYouStore.setState.mock.calls.at(-1)[0];
    expect(callArg.suggestions[0].relevance).toBe(0.9);
    expect(callArg.suggestions[1].relevance).toBe(0.3);
    // unscored goes last (-Infinity sort key)
    expect(callArg.suggestions[2].status).toBe(ArticleSuggestionStatus.Unscored);
  });

  it('counts unscored and relevant articles correctly', async () => {
    const suggestions = [
      { relevance: 0.9, status: ArticleSuggestionStatus.ReasonPending },
      { relevance: 0.1, status: ArticleSuggestionStatus.ReasonPending }, // below display threshold
      { relevance: 0.0, status: ArticleSuggestionStatus.Unscored }, // unscored
    ];
    mockLoadSuggestions.mockResolvedValue(suggestions);

    await refreshSuggestionsInStoreUnsafe();

    const { useForYouStore } = require('@/lib/stores/for-you-store');
    const callArg = useForYouStore.setState.mock.calls.at(-1)[0];
    expect(callArg.unscoredCount).toBe(1);

    // setCounts called with (articleCount, relevantArticleCount)
    expect(mockForYouState.setCounts).toHaveBeenCalledWith(
      10, // existing articleCount
      1,  // only suggestion with relevance > 0.3
    );
  });

  it('falls back to suggestions.length when articleCount is 0 (covers || branch on line 140)', async () => {
    // When articleCount is 0 (falsy), setCounts should use suggestions.length
    mockForYouState.articleCount = 0;
    const suggestions = [
      { relevance: 0.9, status: ArticleSuggestionStatus.ReasonPending },
      { relevance: 0.5, status: ArticleSuggestionStatus.ReasonPending },
    ];
    mockLoadSuggestions.mockResolvedValue(suggestions);

    await refreshSuggestionsInStoreUnsafe();

    // articleCount is 0 → || suggestions.length → 2
    expect(mockForYouState.setCounts).toHaveBeenCalledWith(2, 2);
  });

  it('byRelevanceDesc: sorts two unscored articles (both -Infinity, covers line 148 false branch)', async () => {
    // Covers the `status !== Unscored ? relevance : -Infinity` false branch
    // when BOTH a and b are unscored (both get -Infinity → stable relative order)
    const suggestions = [
      { relevance: 0.0, status: ArticleSuggestionStatus.Unscored }, // unscored
      { relevance: 0.0, status: ArticleSuggestionStatus.Unscored }, // unscored
    ];
    mockLoadSuggestions.mockResolvedValue(suggestions);

    await refreshSuggestionsInStoreUnsafe();

    const { useForYouStore } = require('@/lib/stores/for-you-store');
    const callArg = useForYouStore.setState.mock.calls.at(-1)[0];
    // Both unscored → both -Infinity → sort returns 0, order preserved
    expect(callArg.suggestions).toHaveLength(2);
    expect(callArg.suggestions.every((s: any) => s.status === ArticleSuggestionStatus.Unscored)).toBe(true);
  });
});
