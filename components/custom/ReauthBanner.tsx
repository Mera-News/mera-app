import { HStack } from '@/components/ui/hstack';
import { Icon, AlertCircleIcon, CloseIcon } from '@/components/ui/icon';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useIsOnline } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

// Minimal, non-blocking prompt shown when the server session is confirmed dead
// (auth breaker set needsReauth) AND we're online. Tapping routes to OTP
// re-login. Dismissible per app session only — the flag itself persists until
// a successful re-login clears it, so it returns on next launch if still unsynced.
const ReauthBanner: React.FC = () => {
  const { t } = useTranslation();
  // useIsOnline, not useIsConnected: tapping this opens a login that cannot send
  // an OTP while the server is unreachable, so prompting for one would be a dead
  // end — and it would stack this band on top of the global offline band, which
  // occupies the same coordinates. Deliberately NOT useIsNetworkHealthy: a
  // merely SLOW server can still complete an OTP, so `serverSlow` must not
  // suppress the one banner that offers the user a way out.
  const isOnline = useIsOnline();
  const needsReauth = useUserStore((s) => s.needsReauth);
  const [dismissed, setDismissed] = useState(false);

  if (!needsReauth || !isOnline || dismissed) return null;

  return (
    <HStack testID="reauth-banner" className="items-center bg-warning-900 rounded-lg px-3 py-2 mt-2" space="sm">
      <Icon as={AlertCircleIcon} size="sm" className="text-warning-400" />
      <Pressable testID="reauth-banner-action" className="flex-1" onPress={() => router.push('/login?reauth=1')}>
        <Text size="sm" className="text-warning-400">{t('auth.reauthBanner')}</Text>
      </Pressable>
      <Pressable testID="reauth-banner-dismiss" hitSlop={8} onPress={() => setDismissed(true)}>
        <Icon as={CloseIcon} size="sm" className="text-warning-400" />
      </Pressable>
    </HStack>
  );
};

export default ReauthBanner;
