// The Background refresh row's copy choice and its never-throwing read.

jest.mock('../bg-refresh-settings', () => ({
  isBgRefreshEnabled: jest.fn(async () => false),
  setBgRefreshEnabled: jest.fn(async () => {}),
}));

import {
  bgRefreshDescriptionKey,
  loadBgRefreshToggle,
  saveBgRefreshToggle,
} from '../bg-refresh-ui';

describe('the description follows what the run will do', () => {
  it('cloud on iOS names Low Power Mode and Background App Refresh', () => {
    expect(bgRefreshDescriptionKey(false, 'ios')).toBe('meraProtocol.bgRefreshCloudIos');
  });

  it('cloud on Android names Battery Saver', () => {
    expect(bgRefreshDescriptionKey(false, 'android')).toBe('meraProtocol.bgRefreshCloudAndroid');
  });

  it('on-device says the phone ranks on open, on either platform', () => {
    expect(bgRefreshDescriptionKey(true, 'ios')).toBe('meraProtocol.bgRefreshOnDevice');
    expect(bgRefreshDescriptionKey(true, 'android')).toBe('meraProtocol.bgRefreshOnDevice');
  });
});

describe('the toggle', () => {
  it('reads the stored value', async () => {
    expect(await loadBgRefreshToggle()).toBe(false);
  });

  it('reads ON (the default) when the setting cannot be read', async () => {
    const settings = jest.requireMock('../bg-refresh-settings');
    settings.isBgRefreshEnabled.mockRejectedValueOnce(new Error('db'));
    expect(await loadBgRefreshToggle()).toBe(true);
  });

  it('saves through the settings module, which re-syncs the OS task', async () => {
    const settings = jest.requireMock('../bg-refresh-settings');
    await saveBgRefreshToggle(false);
    expect(settings.setBgRefreshEnabled).toHaveBeenCalledWith(false);
  });
});

describe('the English copy', () => {
  const frag = require('../../locales/_bgsubmit-data-fragments.json');
  const strings: string[] = Object.values(frag.en.meraProtocol);

  it('has no em or en dashes', () => {
    for (const s of strings) expect(s).not.toMatch(/[–—]/);
  });

  it('covers every key the row can ask for', () => {
    for (const key of ['bgRefreshTitle', 'bgRefreshCloudIos', 'bgRefreshCloudAndroid', 'bgRefreshOnDevice']) {
      expect(frag.en.meraProtocol[key]).toEqual(expect.any(String));
    }
  });
});
