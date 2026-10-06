// Frame for a screen pushed inside a tab's stack (You's View-all and settings
// screens): reports its surface (the Mera button's hint and context, and the
// jump-origin Back read it) and contains a crash to the screen.
//
// `backdrop` draws the page gradient behind a SafeAreaView for screens that do
// not draw their own; inside a tab the bottom inset already includes the bar.

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useReportSurface } from './current-surface';
import type { SurfaceId } from './page-registry';

export interface TabStackScreenProps {
  readonly surface: SurfaceId;
  readonly backdrop?: boolean;
  readonly testID?: string;
  readonly children: React.ReactNode;
}

export default function TabStackScreen({ surface, backdrop = false, testID, children }: TabStackScreenProps) {
  useReportSurface(surface);
  const body = (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      {children}
    </ErrorBoundary>
  );
  if (!backdrop) return body;
  return (
    <GluestackUIProvider mode="dark">
      <View style={{ flex: 1 }}>
        <AbstractGradientBackdrop />
        <SafeAreaView testID={testID} style={{ flex: 1 }}>
          {body}
        </SafeAreaView>
      </View>
    </GluestackUIProvider>
  );
}
