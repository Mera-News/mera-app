import React from 'react';
import { useTextScaleStore } from '@/lib/stores/text-scale-store';
import { TextScaleContext } from './TextScaleContext';

/**
 * Bridges the persisted text-scale store into the context every `<Text>` reads.
 *
 * Deliberately the ONLY module that imports both. `./TextScaleContext.tsx` must
 * stay free of the store, because the store reaches the WatermelonDB singleton
 * and `components/ui/text` imports the context — see the note there.
 *
 * This component holds the single store subscription for the whole app, so a
 * text-size change re-renders exactly one component and lets context do the
 * rest.
 */
export const TextScaleProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const scale = useTextScaleStore((s) => s.scale);
  return <TextScaleContext.Provider value={scale}>{children}</TextScaleContext.Provider>;
};
