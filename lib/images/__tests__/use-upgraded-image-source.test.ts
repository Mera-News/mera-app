import { act, renderHook } from '@testing-library/react-native';

import { useUpgradedImageSource } from '../use-upgraded-image-source';
import { HERO_TARGET_PX, COMPACT_TARGET_PX } from '../upgrade-image-url';

const UPGRADEABLE = 'https://www.alphatv.gr/wp-content/uploads/photo-300x200.jpg';
const UPGRADED = 'https://www.alphatv.gr/wp-content/uploads/photo.jpg';
const PLAIN = 'https://example.com/photo.jpg';

describe('useUpgradedImageSource', () => {
  it('starts on the upgraded URL when a rule applies', () => {
    const { result } = renderHook(() => useUpgradedImageSource(UPGRADEABLE, HERO_TARGET_PX));
    expect(result.current.uri).toBe(UPGRADED);
    expect(result.current.upgraded).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it('falls back to the ORIGINAL on the first error, not to the placeholder', () => {
    const { result } = renderHook(() => useUpgradedImageSource(UPGRADEABLE, HERO_TARGET_PX));
    act(() => result.current.onError());
    expect(result.current.uri).toBe(UPGRADEABLE);
    expect(result.current.upgraded).toBe(false);
    expect(result.current.failed).toBe(false);
  });

  it('fails only after BOTH candidates error', () => {
    const { result } = renderHook(() => useUpgradedImageSource(UPGRADEABLE, HERO_TARGET_PX));
    act(() => result.current.onError());
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
    expect(result.current.uri).toBeNull();
  });

  it('starts on the original when no rule applies, and fails after ONE error', () => {
    const { result } = renderHook(() => useUpgradedImageSource(PLAIN, HERO_TARGET_PX));
    expect(result.current.uri).toBe(PLAIN);
    expect(result.current.upgraded).toBe(false);
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
  });

  // Trap 1: the state must reset when the URL changes, or a recycled row
  // inherits the previous article's failure.
  it('RESETS when imageUrl changes', () => {
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useUpgradedImageSource(url, HERO_TARGET_PX),
      { initialProps: { url: UPGRADEABLE } },
    );
    act(() => result.current.onError());
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);

    rerender({ url: 'https://other.example/b-300x200.jpg' });
    expect(result.current.failed).toBe(false);
    expect(result.current.uri).toBe('https://other.example/b.jpg');
  });

  it('does not resurrect a stale upgraded stage for a URL with no rewrite', () => {
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useUpgradedImageSource(url, HERO_TARGET_PX),
      { initialProps: { url: UPGRADEABLE } },
    );
    expect(result.current.upgraded).toBe(true);
    rerender({ url: PLAIN });
    expect(result.current.upgraded).toBe(false);
    expect(result.current.uri).toBe(PLAIN);
  });

  it('enabled:false uses the original but KEEPS the failure path working', () => {
    const { result } = renderHook(() =>
      useUpgradedImageSource(UPGRADEABLE, HERO_TARGET_PX, { enabled: false }),
    );
    expect(result.current.uri).toBe(UPGRADEABLE);
    expect(result.current.upgraded).toBe(false);
    act(() => result.current.onError());
    expect(result.current.failed).toBe(true);
  });

  it('treats a null imageUrl as failed, so the caller renders its placeholder', () => {
    const { result } = renderHook(() => useUpgradedImageSource(null, HERO_TARGET_PX));
    expect(result.current.uri).toBeNull();
    expect(result.current.failed).toBe(true);
  });

  it('applies no binary rule at a compact target', () => {
    const { result } = renderHook(() => useUpgradedImageSource(UPGRADEABLE, COMPACT_TARGET_PX));
    expect(result.current.uri).toBe(UPGRADEABLE);
    expect(result.current.upgraded).toBe(false);
  });
});
