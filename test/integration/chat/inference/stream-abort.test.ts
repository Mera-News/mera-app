// inferStream abort: the toolkit stops llama at once, ends the stream, and keeps the restart
// hold (and the llama lock) until the abandoned completion has unwound.
// inference.ts wraps llama.rn context. We mock _getContext and _updateInferenceSpeed.
// jest.mock() is hoisted above variable declarations, so the factory must be
// self-contained. We grab the mock fn refs from the module after import.

jest.mock('@/lib/mera-protocol-toolkit/core/modelManager', () => ({
  __esModule: true,
  _getContext: jest.fn(),
  _updateInferenceSpeed: jest.fn(),
  // Provide all other exports from modelManager so transitive imports don't crash
  getModelState: jest.fn(() => null),
  initBaseModel: jest.fn(),
  disposeModel: jest.fn(),
  downloadBaseModel: jest.fn(),
  deleteBaseModel: jest.fn(),
  purgeAllBaseModels: jest.fn(),
  cancelActiveDownload: jest.fn(),
  isModelDownloaded: jest.fn(),
  resetContext: jest.fn(),
  _getActiveAdapterId: jest.fn(() => null),
  _setActiveAdapterId: jest.fn(),
}));

import { inferStream } from '@/lib/mera-protocol-toolkit/core/inference';
import type { InferParams } from '@/lib/mera-protocol-toolkit/types';
import type { LlamaContext } from 'llama.rn';
import { activeHolds } from '@/lib/app-restart';
import * as modelManager from '@/lib/mera-protocol-toolkit/core/modelManager';

// Grab typed mock refs from the hoisted mock — safe to do after imports.
const mockGetContext = modelManager._getContext as jest.MockedFunction<typeof modelManager._getContext>;

// Completion mock lives on the context object returned by _getContext.
const mockCompletion = jest.fn();
const mockStopCompletion = jest.fn();
const mockContext = { completion: mockCompletion, stopCompletion: mockStopCompletion } as unknown as LlamaContext;

const BASE_PARAMS: InferParams = {
  prompt: 'What is the capital of France?',
};


const mockActiveHolds = () => activeHolds().filter((h) => h === 'local-inference');

describe('inferStream abort', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContext.mockReturnValue(mockContext);
  });

  it('an already-aborted signal starts no completion and takes no hold', async () => {
    const ac = new AbortController();
    ac.abort();
    const out: string[] = [];
    for await (const t of inferStream(BASE_PARAMS, ac.signal)) out.push(t);
    expect(out).toEqual([]);
    expect(mockCompletion).not.toHaveBeenCalled();
    expect(mockActiveHolds()).toEqual([]);
  });

  it('aborting before the first token stops llama at once, ends the stream, and holds the restart until llama unwinds', async () => {
    let finish!: () => void;
    const unwound = new Promise<void>((r) => { finish = r; });
    mockCompletion.mockImplementation(async () => {
      await unwound;
      return { text: '', tokens_predicted: 0, tokens_evaluated: 1, truncated: false };
    });
    mockStopCompletion.mockResolvedValue(undefined);

    const ac = new AbortController();
    const out: string[] = [];
    let ended = false;
    const consumer = (async () => {
      for await (const t of inferStream(BASE_PARAMS, ac.signal)) out.push(t);
      ended = true;
    })();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockActiveHolds()).toEqual(['local-inference']);

    ac.abort();
    expect(mockStopCompletion).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    // The stream does not finish until llama has unwound (the lock is released after it) ...
    expect(mockActiveHolds()).toEqual(['local-inference']);
    expect(ended).toBe(false);

    finish();
    await consumer;
    expect(out).toEqual([]);
    expect(mockActiveHolds()).toEqual([]);
  });
});
