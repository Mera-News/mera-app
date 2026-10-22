import { onDeviceSteps, type OnDeviceStepsInput } from '@/components/custom/config-mera/on-device-steps';

const none: OnDeviceStepsInput = { onDisk: false, download: null, deviceSupported: true, onDevice: false, chatInCloud: false };
const statuses = (i: OnDeviceStepsInput) => {
  const s = onDeviceSteps(i);
  return [s.model, s.on, s.chat];
};

describe('onDeviceSteps', () => {
  it('no model: only step 1 is open, to download', () => {
    expect(statuses(none)).toEqual(['open', 'hidden', 'hidden']);
    expect(onDeviceSteps(none).phase).toBe('missing');
  });

  it('downloading (or queued): step 1 stays open with its progress', () => {
    for (const download of ['queued', 'downloading'] as const) {
      expect(statuses({ ...none, download })).toEqual(['open', 'hidden', 'hidden']);
      expect(onDeviceSteps({ ...none, download }).phase).toBe('downloading');
    }
  });

  it('failed: step 1 stays open to try again', () => {
    expect(statuses({ ...none, download: 'failed' })).toEqual(['open', 'hidden', 'hidden']);
    expect(onDeviceSteps({ ...none, download: 'failed' }).phase).toBe('failed');
  });

  it("can't run: step 1 says so, even with a file on disk, and nothing else opens", () => {
    const cant = { ...none, deviceSupported: false, onDisk: true };
    expect(statuses(cant)).toEqual(['open', 'hidden', 'hidden']);
    expect(onDeviceSteps(cant).phase).toBe('cantRun');
  });

  it('model on disk, still Private cloud: step 1 done, step 2 open', () => {
    expect(statuses({ ...none, onDisk: true })).toEqual(['done', 'open', 'hidden']);
  });

  it('On this phone is on: step 3 opens, cloud chat off', () => {
    const on = { ...none, onDisk: true, onDevice: true };
    expect(statuses(on)).toEqual(['done', 'done', 'open']);
    expect(onDeviceSteps(on).cloudChat).toBe(false);
  });

  it('cloud chat on: its rows show only once step 3 is open', () => {
    expect(onDeviceSteps({ ...none, onDisk: true, onDevice: true, chatInCloud: true }).cloudChat).toBe(true);
    expect(onDeviceSteps({ ...none, onDisk: true, chatInCloud: true }).cloudChat).toBe(false);
  });
});
