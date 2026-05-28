import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';

/**
 * Hook that executes a callback when the app returns to the foreground
 *
 * @param callback - Function to execute when app comes to foreground
 *
 * @example
 * ```tsx
 * useRefetchOnForeground(() => {
 *   refetchData();
 * });
 * ```
 */
export function useRefetchOnForeground(callback: () => void) {
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      // Detect transition from background/inactive to active (foreground)
      if (
        appState.current.match(/inactive|background/) &&
        nextAppState === 'active'
      ) {
        // App has come to the foreground
        callback();
      }

      appState.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [callback]);
}
