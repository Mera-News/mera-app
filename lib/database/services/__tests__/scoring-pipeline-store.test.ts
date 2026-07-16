// scoring-pipeline-store unit tests
// Mocks: setting-service (WatermelonDB), expo-secure-store adapter,
// @react-native-async-storage/async-storage, and logger. The settings +
// secure-store + async-store mocks are backed by in-memory maps so
// read-modify-write, CAS, and cross-call serialization behave like the real
// stores.

const settingsStore: Record<string, string> = {};
const secureStoreState: Record<string, string> = {};
const asyncStoreState: Record<string, string> = {};

const mockGetSetting = jest.fn(
  (key: string): Promise<string | null> =>
    Promise.resolve(settingsStore[key] ?? null),
);
const mockSetSetting = jest.fn((key: string, value: string): Promise<void> => {
  settingsStore[key] = value;
  return Promise.resolve();
});
const mockDeleteSetting = jest.fn((key: string): Promise<void> => {
  delete settingsStore[key];
  return Promise.resolve();
});

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...args: [string]) => mockGetSetting(...args),
  setSetting: (...args: [string, string]) => mockSetSetting(...args),
  deleteSetting: (...args: [string]) => mockDeleteSetting(...args),
}));

const mockSecureStoreGetItem = jest.fn(
  (key: string): Promise<string | null> =>
    Promise.resolve(secureStoreState[key] ?? null),
);
const mockSecureStoreSetItem = jest.fn(
  (key: string, value: string): Promise<void> => {
    secureStoreState[key] = value;
    return Promise.resolve();
  },
);
const mockSecureStoreDeleteItem = jest.fn((key: string): Promise<void> => {
  delete secureStoreState[key];
  return Promise.resolve();
});

jest.mock('@/lib/utils/secure-store-adapter', () => ({
  secureStore: {
    getItemAsync: (...args: [string]) => mockSecureStoreGetItem(...args),
    setItemAsync: (...args: [string, string]) => mockSecureStoreSetItem(...args),
    deleteItemAsync: (...args: [string]) => mockSecureStoreDeleteItem(...args),
  },
}));

const mockAsyncRemoveItem = jest.fn((key: string): Promise<void> => {
  delete asyncStoreState[key];
  return Promise.resolve();
});

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    removeItem: (...args: [string]) => mockAsyncRemoveItem(...args),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
    warn: jest.fn(),
  },
}));

import type {
  PipelineRun,
  PipelineBatch,
  PipelineStaleError as PipelineStaleErrorType,
} from '../scoring-pipeline-store';

const PIPELINE_KEY = 'async_pipeline_run';
const PIPELINE_PRIVKEY_KEY = 'async_pipeline_privkey';

// The SUT is re-required per test (jest.resetModules) so its module-level
// legacy-cleanup-once flag and writeQueue start fresh each time.
type SUT = typeof import('../scoring-pipeline-store');
let mod: SUT;

function baseRun(
  overrides: Partial<Omit<PipelineRun, 'version' | 'schema'>> = {},
): Omit<PipelineRun, 'version' | 'schema'> {
  return {
    runId: 'run-1',
    startedAt: 1700000000000,
    algo: 'ed25519',
    expoPushToken: 'ExpoPushToken[xxx]',
    batches: [
      {
        batchId: 0,
        phase: 'queued',
        candidateIds: ['a', 'b'],
        attempt: 0,
      } as PipelineBatch,
    ],
    ...overrides,
  };
}

function resetStores() {
  for (const k of Object.keys(settingsStore)) delete settingsStore[k];
  for (const k of Object.keys(secureStoreState)) delete secureStoreState[k];
  for (const k of Object.keys(asyncStoreState)) delete asyncStoreState[k];
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  resetStores();

  // clearAllMocks wipes the stateful implementations; reinstall them.
  mockGetSetting.mockImplementation((key: string) =>
    Promise.resolve(settingsStore[key] ?? null),
  );
  mockSetSetting.mockImplementation((key: string, value: string) => {
    settingsStore[key] = value;
    return Promise.resolve();
  });
  mockDeleteSetting.mockImplementation((key: string) => {
    delete settingsStore[key];
    return Promise.resolve();
  });
  mockSecureStoreGetItem.mockImplementation((key: string) =>
    Promise.resolve(secureStoreState[key] ?? null),
  );
  mockSecureStoreSetItem.mockImplementation((key: string, value: string) => {
    secureStoreState[key] = value;
    return Promise.resolve();
  });
  mockSecureStoreDeleteItem.mockImplementation((key: string) => {
    delete secureStoreState[key];
    return Promise.resolve();
  });
  mockAsyncRemoveItem.mockImplementation((key: string) => {
    delete asyncStoreState[key];
    return Promise.resolve();
  });

  mod = require('../scoring-pipeline-store');
});

// ---------------------------------------------------------------------------
// createPipeline / getPipeline round-trip
// ---------------------------------------------------------------------------

describe('createPipeline + getPipeline', () => {
  it('round-trips the run and merges the privkey from secure store', async () => {
    await mod.createPipeline(baseRun(), 'privhex-abc');

    // Secret written before the row; row carries version 1 + schema 1.
    expect(secureStoreState[PIPELINE_PRIVKEY_KEY]).toBe('privhex-abc');
    const stored = JSON.parse(settingsStore[PIPELINE_KEY]) as PipelineRun;
    expect(stored.version).toBe(1);
    expect(stored.schema).toBe(1);

    const got = await mod.getPipeline();
    expect(got).not.toBeNull();
    expect(got!.run.runId).toBe('run-1');
    expect(got!.run.version).toBe(1);
    expect(got!.run.schema).toBe(1);
    expect(got!.privKeyHex).toBe('privhex-abc');
  });

  it('writes the secret to the keychain, never into the settings row', async () => {
    await mod.createPipeline(baseRun(), 'super-secret-key');
    expect(settingsStore[PIPELINE_KEY]).not.toContain('super-secret-key');
  });

  it('getPipeline returns null when no run exists', async () => {
    expect(await mod.getPipeline()).toBeNull();
  });

  it('throws if a run already exists', async () => {
    await mod.createPipeline(baseRun(), 'k1');
    await expect(mod.createPipeline(baseRun(), 'k2')).rejects.toThrow(
      /already exists/,
    );
  });
});

// ---------------------------------------------------------------------------
// getPipeline self-heal
// ---------------------------------------------------------------------------

describe('getPipeline self-heal', () => {
  it('clears both stores and returns null on corrupted JSON', async () => {
    settingsStore[PIPELINE_KEY] = 'not valid json {{{';
    secureStoreState[PIPELINE_PRIVKEY_KEY] = 'orphan-key';

    const got = await mod.getPipeline();
    expect(got).toBeNull();
    expect(settingsStore[PIPELINE_KEY]).toBeUndefined();
    expect(secureStoreState[PIPELINE_PRIVKEY_KEY]).toBeUndefined();
  });

  it('clears both stores and returns null when the privkey is missing', async () => {
    settingsStore[PIPELINE_KEY] = JSON.stringify({
      schema: 1,
      runId: 'run-x',
      startedAt: 1,
      algo: 'ed25519',
      expoPushToken: null,
      batches: [],
      version: 1,
    });
    // No secret in the keychain.

    const got = await mod.getPipeline();
    expect(got).toBeNull();
    expect(settingsStore[PIPELINE_KEY]).toBeUndefined();
  });

  it('does NOT clear the row on a transient keychain read error', async () => {
    settingsStore[PIPELINE_KEY] = JSON.stringify({
      schema: 1,
      runId: 'run-x',
      startedAt: 1,
      algo: 'ed25519',
      expoPushToken: null,
      batches: [],
      version: 1,
    });
    mockSecureStoreGetItem.mockRejectedValueOnce(new Error('keychain locked'));

    const got = await mod.getPipeline();
    expect(got).toBeNull();
    // Row preserved for retry.
    expect(settingsStore[PIPELINE_KEY]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// mutatePipeline
// ---------------------------------------------------------------------------

describe('mutatePipeline', () => {
  it('applies the mutator, bumps the version, and returns the result', async () => {
    await mod.createPipeline(baseRun(), 'k');

    const out = await mod.mutatePipeline((run) => {
      run.batches[0].phase = 'done';
      return 'my-result';
    });

    expect(out).not.toBe('no-run');
    expect(out).not.toBe('aborted');
    const ok = out as { result: string; run: PipelineRun };
    expect(ok.result).toBe('my-result');
    expect(ok.run.version).toBe(2);
    expect(ok.run.batches[0].phase).toBe('done');

    const persisted = JSON.parse(settingsStore[PIPELINE_KEY]) as PipelineRun;
    expect(persisted.version).toBe(2);
    expect(persisted.batches[0].phase).toBe('done');
  });

  it('returns "no-run" when no run exists', async () => {
    const out = await mod.mutatePipeline(() => 'x');
    expect(out).toBe('no-run');
  });

  it('aborts without writing when the mutator returns null', async () => {
    await mod.createPipeline(baseRun(), 'k');
    const before = settingsStore[PIPELINE_KEY];

    const out = await mod.mutatePipeline((run) => {
      run.batches[0].phase = 'failed'; // mutation on the draft
      return null; // ...but abort
    });

    expect(out).toBe('aborted');
    // Nothing persisted: version still 1, phase unchanged.
    expect(settingsStore[PIPELINE_KEY]).toBe(before);
    const persisted = JSON.parse(settingsStore[PIPELINE_KEY]) as PipelineRun;
    expect(persisted.version).toBe(1);
    expect(persisted.batches[0].phase).toBe('queued');
  });

  it('does not touch the keychain secret', async () => {
    await mod.createPipeline(baseRun(), 'k');
    mockSecureStoreSetItem.mockClear();
    await mod.mutatePipeline((run) => {
      run.batches[0].phase = 'done';
      return 1;
    });
    expect(mockSecureStoreSetItem).not.toHaveBeenCalled();
  });

  it('retries and succeeds when a concurrent context bumps the version once', async () => {
    await mod.createPipeline(baseRun(), 'k');

    let injected = false;
    const out = await mod.mutatePipeline((run) => {
      if (!injected) {
        injected = true;
        // Simulate another JS/native context writing between our read and the
        // pre-write re-read: bump the persisted version out from under us.
        const stored = JSON.parse(settingsStore[PIPELINE_KEY]) as PipelineRun;
        stored.version = 2;
        settingsStore[PIPELINE_KEY] = JSON.stringify(stored);
      }
      run.batches[0].phase = 'done';
      return 'ok';
    });

    const ok = out as { result: string; run: PipelineRun };
    expect(ok.result).toBe('ok');
    // Read v1 (conflict → retry) → read v2 → write v3.
    expect(ok.run.version).toBe(3);
    expect(ok.run.batches[0].phase).toBe('done');
  });

  it('throws PipelineStaleError after 3 conflicting attempts', async () => {
    await mod.createPipeline(baseRun(), 'k');

    await expect(
      mod.mutatePipeline((run) => {
        // Every attempt: bump the persisted version so the pre-write re-read
        // never matches the version we read.
        const stored = JSON.parse(settingsStore[PIPELINE_KEY]) as PipelineRun;
        stored.version += 1;
        settingsStore[PIPELINE_KEY] = JSON.stringify(stored);
        run.batches[0].phase = 'done';
        return 'never';
      }),
    ).rejects.toBeInstanceOf(mod.PipelineStaleError as typeof PipelineStaleErrorType);
  });

  it('serializes concurrent in-process mutates so both land', async () => {
    await mod.createPipeline(baseRun({ batches: [] }), 'k');

    const [a, b] = await Promise.all([
      mod.mutatePipeline((run) => {
        run.batches.push({
          batchId: 1,
          phase: 'queued',
          candidateIds: ['x'],
          attempt: 0,
        });
        return 'a';
      }),
      mod.mutatePipeline((run) => {
        run.batches.push({
          batchId: 2,
          phase: 'queued',
          candidateIds: ['y'],
          attempt: 0,
        });
        return 'b';
      }),
    ]);

    // Neither aborted / missed the run.
    expect(a).not.toBe('no-run');
    expect(b).not.toBe('no-run');

    const persisted = JSON.parse(settingsStore[PIPELINE_KEY]) as PipelineRun;
    // Both writes applied on top of each other: 1 → 2 → 3.
    expect(persisted.version).toBe(3);
    const ids = persisted.batches.map((x) => x.batchId).sort();
    expect(ids).toEqual([1, 2]);
  });

  it('keeps the write queue usable after a PipelineStaleError', async () => {
    await mod.createPipeline(baseRun(), 'k');

    await expect(
      mod.mutatePipeline((run) => {
        const stored = JSON.parse(settingsStore[PIPELINE_KEY]) as PipelineRun;
        stored.version += 1;
        settingsStore[PIPELINE_KEY] = JSON.stringify(stored);
        run.batches[0].phase = 'done';
        return 'x';
      }),
    ).rejects.toBeInstanceOf(mod.PipelineStaleError as typeof PipelineStaleErrorType);

    // A following mutate must still work (chain not wedged).
    const out = await mod.mutatePipeline((run) => {
      run.batches[0].phase = 'failed';
      return 'recovered';
    });
    const ok = out as { result: string; run: PipelineRun };
    expect(ok.result).toBe('recovered');
  });
});

// ---------------------------------------------------------------------------
// clearPipeline
// ---------------------------------------------------------------------------

describe('clearPipeline', () => {
  it('removes both the settings row and the keychain secret', async () => {
    await mod.createPipeline(baseRun(), 'k');
    await mod.clearPipeline();
    expect(settingsStore[PIPELINE_KEY]).toBeUndefined();
    expect(secureStoreState[PIPELINE_PRIVKEY_KEY]).toBeUndefined();
    expect(await mod.getPipeline()).toBeNull();
  });

  it('swallows keychain delete errors', async () => {
    await mod.createPipeline(baseRun(), 'k');
    mockSecureStoreDeleteItem.mockRejectedValueOnce(new Error('keychain error'));
    await expect(mod.clearPipeline()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Legacy cleanup
// ---------------------------------------------------------------------------

describe('legacy cleanup', () => {
  it('deletes the legacy settings, secure-store, and AsyncStorage keys once', async () => {
    settingsStore['async_inference_pending_job'] = 'legacy-row';
    secureStoreState['async_inference_pending_job_privkey'] = 'legacy-secret';
    asyncStoreState['mera.cycle.capabilityToken'] = 'legacy-token';

    await mod.getPipeline();

    expect(settingsStore['async_inference_pending_job']).toBeUndefined();
    expect(
      secureStoreState['async_inference_pending_job_privkey'],
    ).toBeUndefined();
    expect(mockAsyncRemoveItem).toHaveBeenCalledWith('mera.cycle.capabilityToken');
  });

  it('only runs the legacy cleanup once per process', async () => {
    await mod.getPipeline();
    expect(mockAsyncRemoveItem).toHaveBeenCalledTimes(1);
    await mod.getPipeline();
    // Still once — the module-level flag gates it.
    expect(mockAsyncRemoveItem).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PipelineStaleError
// ---------------------------------------------------------------------------

describe('PipelineStaleError', () => {
  it('is an Error with a descriptive name/message', () => {
    const err = new mod.PipelineStaleError(3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PipelineStaleError');
    expect(err.attempts).toBe(3);
    expect(err.message).toContain('3');
  });
});
