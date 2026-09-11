import { OverlayProvider } from '@gluestack-ui/core/overlay/creator';
import { ToastProvider } from '@gluestack-ui/core/toast/creator';
import { useColorScheme } from 'nativewind';
import React, { useEffect } from 'react';
import { View, ViewProps } from 'react-native';

import { config } from './config';

/**
 * `system` is deliberately NOT a member. The provider takes a RESOLVED scheme;
 * resolving 'system' against the OS is the theme store's job (and does not
 * happen at all until P6, while the iOS plist pin stands).
 */
export type ModeType = 'light' | 'dark';

/**
 * `mode` IS REQUIRED.
 *
 * It used to default to 'light', so a bare <GluestackUIProvider> silently
 * flipped the whole app. Nothing should ever mount this except the root, which
 * an eslint no-restricted-imports rule and `__tests__/single-provider.test.ts`
 * both enforce.
 *
 * RENDER INDEXES `config[mode]`, NOT `useColorScheme()`. This is the line that
 * makes light/dark shippable over the air. `react-native-css-interop` populates
 * its `colorSchemeObservable` only under NODE_ENV==='test'; in production
 * `colorScheme.get()` falls through to `systemColorScheme`, which moves only via
 * an async `Appearance` round-trip that the iOS `UIUserInterfaceStyle=Dark`
 * plist pin blocks outright. Indexing by our own resolved mode means the swap is
 * synchronous and owes nothing to native state.
 *
 * `setColorScheme(mode)` is kept as a SIDE EFFECT only: it drives the native
 * keyboard, alerts and share sheet. Nothing in the render path may depend on it
 * having landed.
 */
export function GluestackUIProvider({
  mode,
  ...props
}: {
  mode: ModeType;
  children?: React.ReactNode;
  style?: ViewProps['style'];
}) {
  const { setColorScheme } = useColorScheme();

  useEffect(() => {
    setColorScheme(mode);
    // setColorScheme is stable (useColorScheme hook); re-run only when mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    <View
      style={[config[mode], { flex: 1, height: '100%', width: '100%' }, props.style]}
    >
      <OverlayProvider>
        <ToastProvider>{props.children}</ToastProvider>
      </OverlayProvider>
    </View>
  );
}
