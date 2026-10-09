// The RNFS-backed file the codec writes frames into, over the RNFS byte-store fake. The one thing
// the adapter must get right is that `write` places bytes at a BYTE offset (verified on device by
// dev-probe.ts), so frames can be written sequentially by position.
//
// No legacy suite: the adapter was only reached through mocks of itself (backup-service.test.ts
// replaced it with a stub). It is the file every backup and restore goes through.
import { RnfsFile } from '@/lib/backup/adapters/rnfs-file';

jest.mock('@dr.pogodin/react-native-fs', () => require('./fakes').rnfsModule);

import { resetFakes, shared } from './fakes';

beforeEach(() => resetFakes());

describe('RnfsFile', () => {
  it('starts every writer from a known-empty file, discarding what an aborted run left behind', async () => {
    shared.disk.set('/tmp/a.bin', new Uint8Array([9, 9, 9, 9]));
    const file = await RnfsFile.createEmpty('/tmp/a.bin');
    expect(await file.size()).toBe(0);
  });

  it('places bytes at a byte offset, whatever their length (none a multiple of 3)', async () => {
    const file = await RnfsFile.createEmpty('/tmp/a.bin');
    const frames = [
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7]),
      Uint8Array.from({ length: 11 }, (_, i) => 10 + i),
      Uint8Array.from([100, 101, 102, 103, 104]),
    ];
    let position = 0;
    for (const frame of frames) {
      await file.write(frame, position);
      position += frame.length;
    }

    expect(await file.size()).toBe(23);
    expect([...(await file.read(23, 0))]).toEqual(frames.flatMap((f) => [...f]));
    // a read from the middle of the file, across a frame boundary
    expect([...(await file.read(6, 5))]).toEqual([6, 7, 10, 11, 12, 13]);
  });

  it('returns fewer bytes only at the end of the file', async () => {
    const file = await RnfsFile.createEmpty('/tmp/a.bin');
    await file.write(Uint8Array.from([1, 2, 3]), 0);
    expect([...(await file.read(10, 1))]).toEqual([2, 3]);
  });

  it('writes nothing for an empty chunk and reads nothing for a zero length', async () => {
    const file = await RnfsFile.createEmpty('/tmp/a.bin');
    await file.write(new Uint8Array(0), 0);
    expect(await file.size()).toBe(0);
    expect((await file.read(0, 0)).length).toBe(0);
    expect((await file.read(-5, 0)).length).toBe(0);
  });

  it('overwrites in place when asked to write inside existing bytes', async () => {
    const file = await RnfsFile.createEmpty('/tmp/a.bin');
    await file.write(Uint8Array.from([1, 2, 3, 4]), 0);
    await file.write(Uint8Array.from([9, 9]), 1);
    expect([...(await file.read(4, 0))]).toEqual([1, 9, 9, 4]);
  });

  it('deletes the file, and a file already gone is not an error', async () => {
    const file = await RnfsFile.createEmpty('/tmp/a.bin');
    await file.remove();
    expect(shared.disk.has('/tmp/a.bin')).toBe(false);
    await expect(file.remove()).resolves.toBeUndefined();
  });

  it('never lets a failed cleanup mask the error that caused it', async () => {
    const file = await RnfsFile.createEmpty('/tmp/a.bin');
    shared.failUnlink = true;
    await expect(file.remove()).resolves.toBeUndefined();
  });
});
