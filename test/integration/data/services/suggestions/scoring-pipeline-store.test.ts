// scoring-pipeline-store: the persisted multi-batch scoring run. Non-secret run state lives in the
// `async_pipeline_run` settings row, the run's E2EE private key in the keychain, and every write after
// create goes through mutatePipeline's two-layer defence (in-process queue, cross-context CAS). Real
// `settings` rows and the stateful secure store; expo-secure-store is the edge. The cross-context
// writer is a key-scoped wrapper on getSetting (R26) that bumps the stored version on the pre-write
// re-read, which is exactly what a second JS context winning the race looks like.
// Replaces lib/database/services/__tests__/scoring-pipeline-store.test.ts (legacy cleanup lives in
// scoring-pipeline-legacy-cleanup*.test.ts).
import * as settingService from '@/lib/database/services/setting-service';
import {
  PipelineStaleError,
  clearPipeline,
  createPipeline,
  getPipeline,
  mutatePipeline,
  type PipelineBatch,
  type PipelineRun,
} from '@/lib/database/services/scoring-pipeline-store';
import logger from '@/lib/logger';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { failSecureStore, secureStoreDump } from '@/test/helpers';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

const PIPELINE_KEY = 'async_pipeline_run';
const PRIVKEY_KEY = 'async_pipeline_privkey';

afterEach(() => jest.restoreAllMocks());

const batch = (batchId: number, ids: string[] = ['a', 'b']): PipelineBatch => ({
  batchId,
  phase: 'queued',
  candidateIds: ids,
  attempt: 0,
});

function baseRun(over: Partial<Omit<PipelineRun, 'version' | 'schema'>> = {}): Omit<PipelineRun, 'version' | 'schema'> {
  return {
    runId: 'run-1',
    startedAt: 1_700_000_000_000,
    algo: 'ed25519',
    expoPushToken: 'ExpoPushToken[xxx]',
    batches: [batch(0)],
    ...over,
  };
}

const storedRun = async () => JSON.parse((await settingService.getSetting(PIPELINE_KEY))!) as PipelineRun;

/**
 * From now on, the first `times` pre-write re-reads of the run row find another context's write: the
 * stored version is bumped for real, then read back. (Each mutation attempt reads the row twice: the
 * initial read, then the re-read immediately before the write.)
 */
function otherContextWins(times: number): void {
  const realGet = settingService.getSetting;
  let reads = 0;
  let wins = 0;
  jest.spyOn(settingService, 'getSetting').mockImplementation(async (key: string) => {
    const raw = await realGet(key);
    if (key !== PIPELINE_KEY || raw == null) return raw;
    reads += 1;
    if (reads % 2 === 1 || wins >= times) return raw;
    wins += 1;
    const bumped = { ...(JSON.parse(raw) as PipelineRun) };
    bumped.version += 1;
    await settingService.setSetting(PIPELINE_KEY, JSON.stringify(bumped));
    return JSON.stringify(bumped);
  });
}

describe('createPipeline + getPipeline', () => {
  it('round-trips the run: the row carries schema 3 and version 1, the key comes from the keychain', async () => {
    await createPipeline(baseRun(), 'privhex-abc');

    expect(secureStoreDump()[PRIVKEY_KEY]).toBe('privhex-abc');
    const stored = await storedRun();
    expect(stored).toMatchObject({ version: 1, schema: 3, runId: 'run-1' });

    const got = await getPipeline();
    expect(got!.run).toMatchObject({ runId: 'run-1', version: 1, schema: 3, algo: 'ed25519', batches: [batch(0)] });
    expect(got!.privKeyHex).toBe('privhex-abc');
  });

  it('keeps the secret out of the settings row', async () => {
    await createPipeline(baseRun(), 'super-secret-key');

    expect((await settingService.getSetting(PIPELINE_KEY))!).not.toContain('super-secret-key');
  });

  it('answers null when no run exists', async () => {
    expect(await getPipeline()).toBeNull();
  });

  it('refuses to overwrite a live run', async () => {
    await createPipeline(baseRun(), 'k1');

    await expect(createPipeline(baseRun({ runId: 'run-2' }), 'k2')).rejects.toThrow(/already exists/);

    expect((await storedRun()).runId).toBe('run-1');
    expect(secureStoreDump()[PRIVKEY_KEY]).toBe('k1');
  });

  // The secret goes first, so a crash between the two writes leaves a harmless secret, never a row
  // pointing at a key that was not saved.
  it('writes the secret before the row: a failed row write leaves a secret and no run', async () => {
    jest.spyOn(settingService, 'setSetting').mockRejectedValueOnce(new Error('row write failed (injected)'));

    await expect(createPipeline(baseRun(), 'k')).rejects.toThrow('row write failed');

    expect(secureStoreDump()[PRIVKEY_KEY]).toBe('k');
    expect(await getPipeline()).toBeNull();
  });
});

describe('getPipeline self-heal', () => {
  const rowWithoutKey = JSON.stringify({
    schema: 1,
    runId: 'run-x',
    startedAt: 1,
    algo: 'ed25519',
    expoPushToken: null,
    batches: [],
    version: 1,
  });

  it('clears both stores and answers null for a row it cannot parse', async () => {
    await settingService.setSetting(PIPELINE_KEY, 'not valid json {{{');
    await settingService.setSetting('unrelated', 'kept');
    await secureStore.setItemAsync(PRIVKEY_KEY, 'orphan-key');

    expect(await getPipeline()).toBeNull();

    expect(await settingService.getSetting(PIPELINE_KEY)).toBeNull();
    expect(secureStoreDump()[PRIVKEY_KEY]).toBeUndefined();
    expect(await settingService.getSetting('unrelated')).toBe('kept');
    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'scoring-pipeline-store', method: 'getPipeline' },
    });
  });

  it('clears both stores and answers null when the row is there but its secret is gone', async () => {
    await settingService.setSetting(PIPELINE_KEY, rowWithoutKey);

    expect(await getPipeline()).toBeNull();

    expect(await settingService.getSetting(PIPELINE_KEY)).toBeNull();
  });

  it('reports a failed row delete and still clears the secret', async () => {
    await settingService.setSetting(PIPELINE_KEY, 'not valid json {{{');
    await secureStore.setItemAsync(PRIVKEY_KEY, 'orphan-key');
    const realDelete = settingService.deleteSetting;
    jest.spyOn(settingService, 'deleteSetting').mockImplementation(async (key: string) => {
      if (key === PIPELINE_KEY) throw new Error('row delete failed (injected)');
      return realDelete(key);
    });

    expect(await getPipeline()).toBeNull();

    expect(secureStoreDump()[PRIVKEY_KEY]).toBeUndefined();
    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'scoring-pipeline-store', step: 'clear-row' },
    });
  });

  it('reports a failed secret delete and still clears the row', async () => {
    await settingService.setSetting(PIPELINE_KEY, 'not valid json {{{');
    failSecureStore(PRIVKEY_KEY, 'delete', new Error('keychain error'));

    expect(await getPipeline()).toBeNull();

    expect(await settingService.getSetting(PIPELINE_KEY)).toBeNull();
    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'scoring-pipeline-store', step: 'clear-privkey' },
    });
  });

  // A locked keychain after a reboot is not "missing": clearing here would cost the run for nothing.
  it('does NOT clear the row on a transient keychain read error', async () => {
    await settingService.setSetting(PIPELINE_KEY, rowWithoutKey);
    failSecureStore(PRIVKEY_KEY, 'get', new Error('keychain locked'));

    expect(await getPipeline()).toBeNull();

    expect(await settingService.getSetting(PIPELINE_KEY)).toBe(rowWithoutKey);
    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'scoring-pipeline-store', step: 'read-privkey' },
    });
  });
});

describe('mutatePipeline', () => {
  it('applies the mutator, bumps the version and returns the result', async () => {
    await createPipeline(baseRun(), 'k');

    const out = await mutatePipeline((run) => {
      run.batches[0].phase = 'done';
      return 'my-result';
    });

    expect(out).toMatchObject({ result: 'my-result', run: { version: 2, batches: [{ phase: 'done' }] } });
    expect(await storedRun()).toMatchObject({ version: 2, batches: [{ phase: 'done' }] });
  });

  it('answers "no-run" when there is no run', async () => {
    expect(await mutatePipeline(() => 'x')).toBe('no-run');
  });

  it('aborts without writing when the mutator returns null', async () => {
    await createPipeline(baseRun(), 'k');
    const before = await settingService.getSetting(PIPELINE_KEY);

    const out = await mutatePipeline((run) => {
      run.batches[0].phase = 'failed'; // on the draft...
      return null; // ...but abort
    });

    expect(out).toBe('aborted');
    expect(await settingService.getSetting(PIPELINE_KEY)).toBe(before);
  });

  it('does not touch the keychain secret', async () => {
    await createPipeline(baseRun(), 'k');
    const before = secureStoreDump();

    await mutatePipeline((run) => {
      run.batches[0].phase = 'done';
      return 1;
    });

    expect(secureStoreDump()).toEqual(before);
  });

  it('leaves a row it cannot parse to getPipeline\'s self-heal and answers "no-run"', async () => {
    await settingService.setSetting(PIPELINE_KEY, 'not json');

    expect(await mutatePipeline(() => 'x')).toBe('no-run');

    expect(await settingService.getSetting(PIPELINE_KEY)).toBe('not json');
  });

  it('serializes concurrent in-process mutates so both land', async () => {
    await createPipeline(baseRun({ batches: [] }), 'k');

    const [a, b] = await Promise.all([
      mutatePipeline((run) => {
        run.batches.push(batch(1, ['x']));
        return 'a';
      }),
      mutatePipeline((run) => {
        run.batches.push(batch(2, ['y']));
        return 'b';
      }),
    ]);

    expect(a).not.toBe('no-run');
    expect(b).not.toBe('no-run');
    const persisted = await storedRun();
    // both applied on top of each other: 1 -> 2 -> 3
    expect(persisted.version).toBe(3);
    expect(persisted.batches.map((x) => x.batchId).sort()).toEqual([1, 2]);
  });

  describe('against another context writing the row', () => {
    it('re-reads and re-applies after losing the race once', async () => {
      await createPipeline(baseRun(), 'k');
      otherContextWins(1);
      let applied = 0;

      const out = await mutatePipeline((run) => {
        applied += 1;
        run.batches[0].phase = 'done';
        return 'ok';
      });

      // read v1 (conflict) -> read v2 -> write v3; the mutator ran once per attempt
      expect(out).toMatchObject({ result: 'ok', run: { version: 3, batches: [{ phase: 'done' }] } });
      expect(applied).toBe(2);
    });

    it('throws PipelineStaleError after 3 conflicting attempts, writing nothing of its own', async () => {
      await createPipeline(baseRun(), 'k');
      otherContextWins(3);

      await expect(
        mutatePipeline((run) => {
          run.batches[0].phase = 'done';
          return 'never';
        }),
      ).rejects.toMatchObject({ name: 'PipelineStaleError', attempts: 3 });

      const stored = await storedRun();
      expect(stored.batches[0].phase).toBe('queued');
      expect(stored.version).toBe(4); // the three versions the other context wrote, on top of v1
    });

    it('keeps the write queue usable after a PipelineStaleError', async () => {
      await createPipeline(baseRun(), 'k');
      otherContextWins(3);
      await expect(mutatePipeline(() => 'x')).rejects.toBeInstanceOf(PipelineStaleError);
      jest.restoreAllMocks();

      const out = await mutatePipeline((run) => {
        run.batches[0].phase = 'failed';
        return 'recovered';
      });

      expect(out).toMatchObject({ result: 'recovered', run: { batches: [{ phase: 'failed' }] } });
    });

    it('answers "no-run" when the run vanished between the read and the write', async () => {
      await createPipeline(baseRun(), 'k');
      const realGet = settingService.getSetting;
      let reads = 0;
      jest.spyOn(settingService, 'getSetting').mockImplementation(async (key: string) => {
        if (key === PIPELINE_KEY && (reads += 1) === 2) {
          await settingService.deleteSetting(PIPELINE_KEY);
          return null;
        }
        return realGet(key);
      });

      expect(await mutatePipeline((run) => ((run.batches[0].phase = 'done'), 'x'))).toBe('no-run');
    });

    it('treats a row corrupted under it as a conflict, then gives up on it', async () => {
      await createPipeline(baseRun(), 'k');
      const realGet = settingService.getSetting;
      let reads = 0;
      jest.spyOn(settingService, 'getSetting').mockImplementation(async (key: string) => {
        if (key === PIPELINE_KEY && (reads += 1) === 2) {
          await settingService.setSetting(PIPELINE_KEY, 'corrupted');
          return 'corrupted';
        }
        return realGet(key);
      });

      expect(await mutatePipeline(() => 'x')).toBe('no-run');
    });
  });
});

describe('clearPipeline', () => {
  it('removes the settings row and the keychain secret', async () => {
    await createPipeline(baseRun(), 'k');

    await clearPipeline();

    expect(await settingService.getSetting(PIPELINE_KEY)).toBeNull();
    expect(secureStoreDump()[PRIVKEY_KEY]).toBeUndefined();
    expect(await getPipeline()).toBeNull();
  });

  it('swallows a keychain delete error and reports it, the row already gone', async () => {
    await createPipeline(baseRun(), 'k');
    failSecureStore(PRIVKEY_KEY, 'delete', new Error('keychain error'));

    await expect(clearPipeline()).resolves.toBeUndefined();

    expect(await settingService.getSetting(PIPELINE_KEY)).toBeNull();
    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'scoring-pipeline-store', step: 'clear-privkey' },
    });
    // a secret without a row is harmless: getPipeline never surfaces it
    expect(await getPipeline()).toBeNull();
  });
});

describe('PipelineStaleError', () => {
  it('is an Error carrying its attempt count in a descriptive name and message', () => {
    const err = new PipelineStaleError(3);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PipelineStaleError');
    expect(err.attempts).toBe(3);
    expect(err.message).toContain('3');
  });
});
