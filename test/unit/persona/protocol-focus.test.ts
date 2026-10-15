import { protocolFocusPlan } from '@/components/custom/config-mera/protocol-focus';

const base = { focus: 'on-device', done: false, sectionY: 120, rowTag: 42 };

describe('protocolFocusPlan', () => {
  it('scrolls the section into view with a small gap and focuses the row', () => {
    expect(protocolFocusPlan(base)).toEqual({ scrollY: 104, tag: 42 });
  });

  it('never scrolls above the top', () => {
    expect(protocolFocusPlan({ ...base, sectionY: 4 })).toEqual({ scrollY: 0, tag: 42 });
  });

  it('waits until both layouts are known, in either order', () => {
    expect(protocolFocusPlan({ ...base, sectionY: null })).toBeNull();
    expect(protocolFocusPlan({ ...base, rowTag: null })).toBeNull();
  });

  it('does nothing without the param, for another value, or a second time', () => {
    expect(protocolFocusPlan({ ...base, focus: undefined })).toBeNull();
    expect(protocolFocusPlan({ ...base, focus: 'cloud' })).toBeNull();
    expect(protocolFocusPlan({ ...base, done: true })).toBeNull();
  });
});
