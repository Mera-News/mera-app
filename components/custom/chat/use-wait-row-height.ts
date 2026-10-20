// The wait row's height for this reader, shared by the wait row and the
// streaming reply that takes its slot, so both compute it the same way.

import { MAX_FONT_SCALE } from '@/lib/algorithms/policy';
import { useTextScale } from '@/lib/typography/TextScaleContext';
import { useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { phaseLineHeight, waitRowHeight } from './chat-phases';

/** The effective text scale, capped like `useAdaptiveLineClamp`. */
function useEffectiveTextScale(): number {
  const { fontScale } = useWindowDimensions();
  return Math.min(fontScale, MAX_FONT_SCALE.content) * useTextScale();
}

export function useWaitRowHeight(showWords: boolean, engine: 'cloud' | 'local'): number {
  const textScale = useEffectiveTextScale();
  const { i18n } = useTranslation();
  return waitRowHeight({ showWords, engine, textScale, language: i18n.language ?? 'en' });
}

/** The wait line's line height for this reader's script. */
export function usePhaseLineHeight(): number {
  const { i18n } = useTranslation();
  return phaseLineHeight(i18n.language ?? 'en');
}
