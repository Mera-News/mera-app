import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import { setIdentitySwitchBlocked } from '@/lib/security/identity-gate';
import { signOutAndWipe } from '@/lib/security/local-wipe';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * Shown when a cross-user wipe FAILED and the app therefore may not enter the
 * shell.
 *
 * ── THIS SCREEN READS NO STORE AND NO PERSONA ───────────────────────────────
 *
 * Not a style preference, a correctness rule. `wipeAllLocalUserData` clears the
 * database and only then resets Zustand, so on a DB failure — the exact failure
 * that mounts this screen — every in-memory store still holds the PREVIOUS
 * user's data. Rendering a name, an email, a persona fact or a saved-article
 * count here would show user A's data to user B on the very screen that exists
 * because A's data could not be removed. Static copy only. If you find yourself
 * adding a `useUserStore` or a `useTranslation` interpolation carrying user
 * data, that is the leak reappearing.
 *
 * The other half of failing closed lives in the caller: it must NOT stamp
 * `cached_user_id` and must NOT route. Leaving the stamp as the previous owner
 * is the retry marker — it is what makes the next launch re-detect the mismatch
 * and try again, the same principle `purgeOrphanedLocalData` uses.
 *
 * ── AND NO DECORATION ───────────────────────────────────────────────────────
 *
 * Flat black, no `AbstractGradientBackdrop` and no `MeraLogo`. Both pull
 * react-native-reanimated and react-native-svg, and the backdrop additionally
 * reads `useDisplayPrefsStore` — a Zustand read on the one screen whose whole
 * contract is that it reads no store. This screen renders precisely when the
 * local database has just failed, which is the worst possible moment to be
 * mounting an animation stack. Every import here is load-bearing; adding one
 * back is a regression, not a polish.
 */

/**
 * Retries are bounded PER PROCESS, not per mount. A remount must not hand back
 * a fresh budget: the same three failing calls would then loop for as long as
 * the user keeps tapping, and each one resets the database.
 */
const MAX_RETRIES = 3;
let retriesUsed = 0;

/** Test-only: reset the per-process retry budget. */
export function __resetIdentitySwitchRetriesForTests(): void {
  retriesUsed = 0;
}

export interface IdentitySwitchFailedScreenProps {
  /**
   * Re-run the wipe. The caller owns it, because the caller is the thing that
   * knows which user we are switching TO — this screen deliberately knows
   * nothing about either identity.
   */
  readonly onRetry: () => void;
}

export default function IdentitySwitchFailedScreen({ onRetry }: IdentitySwitchFailedScreenProps) {
  const { t } = useTranslation();
  const [signingOut, setSigningOut] = useState(false);
  const [exhausted, setExhausted] = useState(retriesUsed >= MAX_RETRIES);

  // Tell the watcher in app/logged-in/_layout.tsx to stand down while this is
  // up. The ids genuinely disagree here, which is precisely the condition the
  // watcher fires on, and it must not navigate out from under a user who is
  // looking at an unrecoverable state.
  useEffect(() => {
    setIdentitySwitchBlocked(true);
    return () => setIdentitySwitchBlocked(false);
  }, []);

  const handleRetry = useCallback(() => {
    if (retriesUsed >= MAX_RETRIES) {
      setExhausted(true);
      return;
    }
    retriesUsed += 1;
    if (retriesUsed >= MAX_RETRIES) setExhausted(true);
    onRetry();
  }, [onRetry]);

  // ALWAYS ENABLED, including while a retry is in flight and after the budget
  // is spent. This is the only guaranteed way off the screen, and it works even
  // when the wipe throws again because signOutAndWipe navigates BEFORE it
  // erases. Disabling it behind the failing operation would trap the user.
  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await signOutAndWipe();
    } catch (error) {
      // The navigation has already happened by the time anything here can
      // throw, so the user is out regardless. The device is left with no
      // credentials and data still on disk, which the launch-time orphan purge
      // reads as an interrupted logout and finishes on the next start.
      logger.captureException(error, {
        tags: { component: 'IdentitySwitchFailedScreen', method: 'handleSignOut' },
      });
    }
  }, []);

  return (
    <Box className="flex-1 bg-black">
      <SafeAreaView style={{ flex: 1 }}>
        <VStack className="flex-1 items-center justify-center px-6" space="lg">
          <Heading size="2xl" className="text-white text-center">
            {t('auth.identitySwitchFailedTitle')}
          </Heading>

          <Text size="md" className="text-gray-300 text-center leading-relaxed">
            {t('auth.identitySwitchFailedBody')}
          </Text>

          <Text size="md" className="text-gray-300 text-center leading-relaxed">
            {t('auth.identitySwitchFailedWhy')}
          </Text>

          {exhausted ? (
            <Text size="sm" className="text-primary-400 text-center">
              {t('auth.identitySwitchFailedExhausted')}
            </Text>
          ) : null}

          <VStack space="sm" className="w-full max-w-md mt-2">
            <Button
              testID="identity-switch-retry"
              onPress={handleRetry}
              disabled={exhausted || signingOut}
              className="bg-primary-500 w-full rounded-full h-auto min-h-11 py-2.5"
              size="lg"
            >
              <ButtonText className="text-white font-semibold">
                {t('auth.identitySwitchRetry')}
              </ButtonText>
            </Button>

            <Button
              testID="identity-switch-sign-out"
              onPress={handleSignOut}
              variant="outline"
              className="w-full rounded-full border-white/30"
              size="lg"
            >
              {signingOut ? <Spinner size="small" className="mr-2" /> : null}
              <ButtonText className="text-white">
                {t('auth.identitySwitchSignOut')}
              </ButtonText>
            </Button>
          </VStack>
        </VStack>
      </SafeAreaView>
    </Box>
  );
}
