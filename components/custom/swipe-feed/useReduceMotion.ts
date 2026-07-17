// useReduceMotion — local hook for the Browse swipe deck. Mirrors the inline
// AccessibilityInfo pattern in components/custom/tabs/TabsTooltipStrip.tsx. When
// the OS "Reduce Motion" setting is on, the deck skips decorative insert
// animations (scroll corrections are already instant/`animated:false`).

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(enabled);
      })
      .catch(() => {
        /* default: motion enabled */
      });

    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => setReduceMotion(enabled),
    );

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return reduceMotion;
}
