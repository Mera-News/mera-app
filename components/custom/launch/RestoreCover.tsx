import { usePathname } from 'expo-router';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';

import {
  isPastStartupGates,
  isRestoreBoot,
  RESTORE_LOOK_MAX_MS,
  restoreLookState,
  subscribeRestoreLook,
} from '@/lib/splash-hold';

/**
 * ANDROID ONLY: the launch look over an update reload's rebuild of the reader's
 * spot. iOS keeps its native splash held instead (lib/splash-hold.ts); Android
 * holds nothing, so without this the reader would watch the startup tab and
 * then every pushed screen of the rebuild. The same background and logo as the
 * native splash (app.json `expo-splash-screen`), so the handoff is invisible.
 *
 * Up from the first render of a restore boot until the rebuild is done. Never
 * stuck: it also leaves when the gate routes somewhere without rebuilding (a
 * sign-in, onboarding) and at the restore look's cap.
 */
export default function RestoreCover(): React.ReactElement | null {
  const [restoreBoot, setRestoreBoot] = useState(false);
  const [capped, setCapped] = useState(false);
  const look = useSyncExternalStore(subscribeRestoreLook, restoreLookState);
  const pathname = usePathname();

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    let alive = true;
    void isRestoreBoot().then((yes) => alive && setRestoreBoot(yes));
    const cap = setTimeout(() => setCapped(true), RESTORE_LOOK_MAX_MS);
    return () => {
      alive = false;
      clearTimeout(cap);
    };
  }, []);

  if (Platform.OS !== 'android' || !restoreBoot || capped || look === 'done') return null;
  // Routed past the gates without a rebuild: nothing to hide.
  if (look === 'none' && isPastStartupGates(pathname)) return null;
  return (
    <View testID="restore-cover" style={styles.cover} pointerEvents="auto" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Image source={require('@/assets/icons/splash-icon-light.png')} style={styles.logo} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000000', alignItems: 'center', justifyContent: 'center' },
  logo: { width: 200, height: 200 },
});
