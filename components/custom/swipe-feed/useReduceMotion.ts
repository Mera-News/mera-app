// useReduceMotion — local hook for the Feed swipe deck. Mirrors the inline
// AccessibilityInfo pattern used elsewhere. When the OS "Reduce Motion" setting
// is on, the deck skips decorative rotation/spring animations and fades instead.

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
