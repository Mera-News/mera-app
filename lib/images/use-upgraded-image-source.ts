// use-upgraded-image-source — the ONE two-step image fallback in the app.
//
// States: upgraded -> original -> failed (the caller then renders its
// placeholder). Both card shapes consume this hook rather than writing their
// own machine, so the hero and the compact row can never disagree about what a
// broken image means.
//
// The state is KEYED ON `imageUrl`. `ArticleCardBase` is `React.memo`'d and the
// feed uses a stable `keyExtractor`, so today a row unmounts rather than
// recycling across articles and a bare `useState` happens to be safe. A
// two-step machine makes the latent version much worse: a card that fell back
// once would stay fallen back for whatever recycled into it. Keying on the URL
// costs one comparison and removes the class of bug entirely.

import { useCallback, useRef, useState } from 'react';

import { upgradeImageUrl } from './upgrade-image-url';

export type UpgradeStage = 'upgraded' | 'original' | 'failed';

export interface UpgradedImageSource {
  /** What to hand the <Image>. `null` once both candidates have failed. */
  uri: string | null;
  /** Pass straight to the <Image>'s `onError`. */
  onError: () => void;
  /** True once neither candidate can render: the caller shows its placeholder. */
  failed: boolean;
  /** True while showing a rewritten URL (so a caller can count rewrites served). */
  upgraded: boolean;
  /** Current stage, for observability counters. */
  stage: UpgradeStage;
}

export interface UseUpgradedImageSourceOptions {
  /**
   * When false the rewrite is skipped and the original is used, with the SAME
   * failure machine still active. Used for `blurImages`: under `blurRadius: 24`
   * the extra bytes are decoded solely to be destroyed.
   */
  enabled?: boolean;
}

export function useUpgradedImageSource(
  imageUrl: string | null | undefined,
  targetPx: number,
  options: UseUpgradedImageSourceOptions = {},
): UpgradedImageSource {
  const enabled = options.enabled !== false;
  const url = imageUrl ?? null;

  const upgradedUri = url && enabled ? upgradeImageUrl(url, targetPx) : url;
  // `upgradeImageUrl` returns its input BY REFERENCE when nothing matched, so
  // this is a pointer comparison, not a string compare.
  const hasRewrite = !!url && upgradedUri !== url;

  const [stage, setStage] = useState<UpgradeStage>(hasRewrite ? 'upgraded' : 'original');

  // Reset when the URL changes, without an effect: an effect would render one
  // frame of the previous article's failure state first.
  const keyRef = useRef<string | null>(url);
  if (keyRef.current !== url) {
    keyRef.current = url;
    setStage(hasRewrite ? 'upgraded' : 'original');
  }

  const onError = useCallback(() => {
    setStage((prev) => (prev === 'upgraded' ? 'original' : 'failed'));
  }, []);

  // A stale 'upgraded' can survive one render after the url changes to one with
  // no rewrite; resolve against what this render actually has.
  const effectiveStage: UpgradeStage =
    stage === 'upgraded' && !hasRewrite ? 'original' : stage;

  let uri: string | null;
  if (!url || effectiveStage === 'failed') uri = null;
  else if (effectiveStage === 'upgraded') uri = upgradedUri;
  else uri = url;

  return {
    uri,
    onError,
    failed: effectiveStage === 'failed' || !url,
    upgraded: effectiveStage === 'upgraded',
    stage: effectiveStage,
  };
}
