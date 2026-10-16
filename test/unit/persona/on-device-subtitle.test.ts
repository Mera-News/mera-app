import { onDeviceSubtitleKind } from '@/components/custom/config-mera/on-device-subtitle';

describe('onDeviceSubtitleKind', () => {
  it('shows the cantRun reason alone when the phone cannot run it', () => {
    expect(onDeviceSubtitleKind(true)).toBe('cantRun');
  });
  it('names the Private cloud need otherwise', () => {
    expect(onDeviceSubtitleKind(false)).toBe('needsCloud');
  });
});
