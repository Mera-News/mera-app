import React, { useEffect } from 'react';
import { config } from './config';
import { View, ViewProps } from 'react-native';
import { OverlayProvider } from '@gluestack-ui/core/overlay/creator';
import { ToastProvider } from '@gluestack-ui/core/toast/creator';
import { useColorScheme } from 'nativewind';

import { useThemeMode } from '@/lib/theme/tokens';

/**
 * The theme for everything inside it comes from the app's theme store
 * (lib/theme/theme-store.ts, via useThemeMode), NEVER from the OS scheme:
 * indexing `config[colorScheme]` from NativeWind let `Appearance.setColorScheme`
 * and the phone's own setting repaint text the app had not themed (spike 5).
 * Modal hosts are separate native windows, so each mounts its own provider.
 */
export function GluestackUIProvider({
  ...props
}: {
  children?: React.ReactNode;
  style?: ViewProps['style'];
}) {
  const mode = useThemeMode();
  const { setColorScheme } = useColorScheme();

  useEffect(() => {
    // Keeps NativeWind's `dark:` variant in step with the store (none are used
    // today); its value never decides the colours below.
    setColorScheme(mode);
    // setColorScheme is stable (useColorScheme hook); re-run only when mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    <View
      style={[
        config[mode],
        { flex: 1, height: '100%', width: '100%' },
        props.style,
      ]}
    >
      <OverlayProvider>
        <ToastProvider>{props.children}</ToastProvider>
      </OverlayProvider>
    </View>
  );
}
