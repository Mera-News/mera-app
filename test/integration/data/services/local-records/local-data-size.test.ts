// local-data-size at its seam. Pragmas are faked at the database edge: the in-memory test adapter
// has no SQL. The file system is the in-memory fake, free space the one native call.
import { getFreeDiskStorageAsync } from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';

import database from '@/lib/database';
import { readLocalDataSizes } from '@/lib/database/local-data-size';
import { RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { resetFileSystem } from '@/test/helpers/fs';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('expo-file-system/legacy', () => ({ getFreeDiskStorageAsync: jest.fn() }));

const pragmas = (values: Record<string, unknown>) =>
  jest.spyOn(database, 'get').mockReturnValue({
    query: (clause: { sql: string }) => ({
      unsafeFetchRaw: async () => {
        const name = clause.sql.replace('pragma ', '');
        if (!(name in values)) throw new Error('no such pragma');
        return [{ [name]: values[name] }];
      },
    }),
  } as never);

const HEALTHY = { page_count: 100, freelist_count: 25, page_size: 4096 };
const free = getFreeDiskStorageAsync as jest.Mock;

beforeEach(() => {
  resetFileSystem();
  free.mockResolvedValue(9_000);
});
afterEach(() => jest.restoreAllMocks());

const writeFile = (content: string, ...parts: string[]) => new File(Paths.document, ...parts).write(content);
const writeModel = (content: string) => new File(Paths.cache, 'mera-models', RELEVANCE_MODEL.modelId, 'model.gguf').write(content);

describe('readLocalDataSizes', () => {
  it('subtracts free pages, with no model and no backup on the phone', async () => {
    pragmas(HEALTHY);

    await expect(readLocalDataSizes()).resolves.toEqual({
      databaseBytes: 75 * 4096,
      modelBytes: null,
      backupBytes: 0,
      freeBytes: 9_000,
    });
  });

  it('reads the model file and adds up a staged backup', async () => {
    pragmas(HEALTHY);
    await writeModel('12345');
    await writeFile('123', 'backup', 'a.bin');
    await writeFile('1234', 'backup', 'b.bin');

    await expect(readLocalDataSizes()).resolves.toMatchObject({ modelBytes: 5, backupBytes: 7 });
  });

  it('gives null when a database read fails, never a partial figure', async () => {
    pragmas({ page_count: 100, page_size: 4096 });

    await expect(readLocalDataSizes()).resolves.toBeNull();
  });

  it('gives null when a pragma returns no number', async () => {
    pragmas({ ...HEALTHY, page_count: null });

    await expect(readLocalDataSizes()).resolves.toBeNull();
  });

  it('a failed free-space read costs only freeBytes', async () => {
    pragmas(HEALTHY);
    free.mockRejectedValue(new Error('unavailable'));

    await expect(readLocalDataSizes()).resolves.toMatchObject({ databaseBytes: 75 * 4096, freeBytes: null });
  });
});
