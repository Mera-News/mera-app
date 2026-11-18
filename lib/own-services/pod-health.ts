import { create } from 'zustand';
import type { PodError } from './pod-client';

export type PodHealth = 'ok' | 'unreachable' | 'refused' | 'phone-old' | 'server-old';

export const usePodHealth = create<{ health: PodHealth | null }>(() => ({ health: null }));

export const recordPodOk = (): void => usePodHealth.setState({ health: 'ok' });

export function recordPodError(e: PodError): void {
  if (e.code === 'unreachable' || e.code === 'refused' || e.code === 'phone-old' || e.code === 'server-old') {
    usePodHealth.setState({ health: e.code });
  }
}

export const resetPodHealth = (): void => usePodHealth.setState({ health: null });
