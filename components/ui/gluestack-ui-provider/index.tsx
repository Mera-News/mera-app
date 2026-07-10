import React, { useEffect } from 'react';
import { config } from './config';
import { View, ViewProps } from 'react-native';
import { OverlayProvider } from '@gluestack-ui/core/overlay/creator';
import { ToastProvider } from '@gluestack-ui/core/toast/creator';
import { useColorScheme } from 'nativewind';
import { useThemeStore } from '@/lib/stores/theme-store';

export type ModeType = 'light' | 'dark' | 'system';

export function GluestackUIProvider({
  mode,
  ...props
}: {
  /** Omit to follow the user's theme preference; pass to force a mode (e.g. video chrome). */
  mode?: ModeType;
  children?: React.ReactNode;
  style?: ViewProps['style'];
}) {
  const preference = useThemeStore((s) => s.preference);
  const effectiveMode = mode ?? preference;
  const { colorScheme, setColorScheme } = useColorScheme();

  useEffect(() => {
    setColorScheme(effectiveMode);
    // setColorScheme is stable (useColorScheme hook); re-run only when mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveMode]);

  return (
    <View
      style={[
        config[colorScheme!],
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
