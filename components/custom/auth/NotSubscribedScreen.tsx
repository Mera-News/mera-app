import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from "@/components/custom/MeraLogo";
import { Box } from "@/components/ui/box";
import { Button, ButtonText } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { VStack } from "@/components/ui/vstack";
import { AccountService } from "@/lib/account-service";
import { authClient } from "@/lib/auth-client";
import { SUPPORT_EMAIL } from "@/lib/config/branding";
import { setSetting } from "@/lib/database/services/setting-service";
import { FIRST_OPEN_DISMISSED_SETTING_KEY } from "@/components/custom/subscription/FirstOpenPaywallGate";
import logger from "@/lib/logger";
import {
    getCustomerInfoSafe,
    getOfferingSafe,
    isRevenueCatConfigured,
    logRevenueCatDiagnostics,
} from "@/lib/revenuecat";
import { useSubscriptionStore } from "@/lib/stores/subscription-store";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, TouchableOpacity, View } from "react-native";
import RevenueCatUI, { PAYWALL_RESULT } from "react-native-purchases-ui";
import { SafeAreaView } from "react-native-safe-area-context";

export interface NotSubscribedScreenProps {
    /**
     * `'lapsed'` — the user HAD a plan and it ended. Softened: no auto-presented
     * purchase sheet, its own copy, and an explicit way out.
     *
     * `undefined` — the default, and deliberately unchanged from what it always
     * was, including the auto-present on mount. This is also the mode the
     * first-open push reuses: that is the primary conversion moment and is
     * meant to be the more assertive of the two.
     */
    readonly reason?: 'lapsed';
}

export default function NotSubscribedScreen({ reason }: NotSubscribedScreenProps = {}) {
    const isLapsed = reason === 'lapsed';
    const { data: session, isPending: isSessionPending } = authClient.useSession();
    const router = useRouter();
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const presentedRef = useRef(false);

    const userId = session?.user?.id;

    // The server is the source of truth: getUserPersona succeeds (200) only once
    // the user's tier has been synced from RevenueCat. A 402/other error means
    // "not subscribed yet".
    const checkServerSubscribed = useCallback(async (): Promise<boolean> => {
        if (!userId) return false;
        try {
            await AccountService.getUserPersona(userId);
            return true;
        } catch {
            return false;
        }
    }, [userId]);

    // After a purchase, the RevenueCat webhook updates the server tier
    // asynchronously — poll a few times before falling back to a manual refresh.
    const pollUntilSubscribed = useCallback(async (): Promise<boolean> => {
        for (let i = 0; i < 6; i++) {
            if (await checkServerSubscribed()) {
                router.replace('/logged-in');
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return false;
    }, [checkServerSubscribed, router]);

    const presentPaywall = useCallback(async () => {
        if (!isRevenueCatConfigured()) return;
        setBusy(true);
        setMessage(null);
        try {
            // Dump the full RevenueCat state to the logs before presenting —
            // diagnoses empty offerings / products-not-fetched issues in dev.
            if (__DEV__) await logRevenueCatDiagnostics();
            // Present the mera-news-subscription offering's paywall (both tiers),
            // falling back to the current offering if it can't be fetched.
            const offering = await getOfferingSafe();
            const result = await RevenueCatUI.presentPaywall(
                offering ? { offering } : {},
            );
            if (
                result === PAYWALL_RESULT.PURCHASED ||
                result === PAYWALL_RESULT.RESTORED
            ) {
                // Optimistically reflect the purchase in the store, then wait for
                // the server to catch up via the webhook.
                const info = await getCustomerInfoSafe();
                if (info) useSubscriptionStore.getState().setCustomerInfo(info);
                setMessage(t('subscription.activating'));
                const ok = await pollUntilSubscribed();
                if (!ok) setMessage(t('subscription.activationDelayed'));
            }
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'NotSubscribedScreen', method: 'presentPaywall' },
            });
        } finally {
            setBusy(false);
        }
    }, [pollUntilSubscribed, t]);

    // Auto-present the paywall once when the gate is reached.
    //
    // Skipped for `lapsed`: this user just lost something, and opening a
    // purchase sheet over the explanation is the aggressive-funnel move the
    // tone direction rejects. They read first and tap "View plans" if they want
    // it. Every other entry point keeps the original behaviour.
    useEffect(() => {
        if (isLapsed) return;
        if (!presentedRef.current && userId && isRevenueCatConfigured()) {
            presentedRef.current = true;
            void presentPaywall();
        }
    }, [isLapsed, userId, presentPaywall]);

    // Drop into the app in companion mode. `replace`, not `push`: this screen
    // must not sit on the back stack waiting to be swiped back into.
    const handleContinueWithoutPlan = useCallback(async () => {
        // Default mode = the first-open push. Record the dismissal BEFORE
        // navigating, so it cannot be lost if the user kills the app on the way
        // out and gets asked again on the next launch.
        //
        // Not written for `lapsed`: that one's "shown once" state is the
        // server's, and a local flag here would be a second, conflicting
        // source of truth for the same question.
        if (!isLapsed) {
            try {
                await setSetting(FIRST_OPEN_DISMISSED_SETTING_KEY, 'true');
            } catch (error) {
                // Non-fatal: worst case the push appears once more.
                logger.captureException(error, {
                    tags: { component: 'NotSubscribedScreen', method: 'dismissFirstOpen' },
                });
            }
        }
        router.replace('/logged-in/app_container/feed');
    }, [isLapsed, router]);

    const handleRefresh = async () => {
        setBusy(true);
        setMessage(null);
        if (await checkServerSubscribed()) {
            router.replace('/logged-in');
        } else {
            setBusy(false);
        }
    };

    if (isSessionPending) {
        return (
            // No opaque fill: the AbstractGradientBackdrop below is the page background.
            <Box className="flex-1 justify-center items-center">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Spinner size="large" />
            </Box>
        );
    }

    return (
        // Unpadded wrapper. The backdrop is mounted OUTSIDE the SafeAreaView so
        // it spans the FULL screen including the safe areas — inside it, the
        // insets left black strips top and bottom. The content keeps its insets.
        <View style={{ flex: 1 }}>
            {/* Page background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

            <SafeAreaView style={{ flex: 1 }}>
              {/* No opaque fill: the backdrop above is the page background. */}
              <Box className="flex-1 justify-center items-center px-6">
                  <VStack space="xl" className="items-center max-w-md">
                      <Box className="items-center mb-8">
                          <MeraLogo size={150} />
                      </Box>
                      <Heading size="2xl" className="text-white text-center">
                          {isLapsed ? t('companion.lapseTitle') : t('subscription.title')}
                      </Heading>

                      <Text size="lg" className="text-gray-300 text-center leading-relaxed">
                          {isLapsed ? t('companion.lapseBody') : t('subscription.description')}
                      </Text>

                      {message ? (
                          <Text size="md" className="text-primary-400 text-center">
                              {message}
                          </Text>
                      ) : null}

                      <Box className="items-center w-full mt-6">
                          <VStack space="md" className="w-full">
                              <Button
                                  onPress={presentPaywall}
                                  disabled={busy}
                                  className="bg-primary-500 w-full"
                                  size="lg"
                              >
                                  {busy ? <Spinner size="small" className="mr-2" /> : null}
                                  <ButtonText className="text-white">
                                      {t('subscription.viewPlans')}
                                  </ButtonText>
                              </Button>
                              <Button
                                  onPress={handleRefresh}
                                  disabled={busy}
                                  variant="outline"
                                  className="border-primary-500 w-full"
                                  size="lg"
                              >
                                  <ButtonText className="text-white">
                                      {busy ? t('common.checking') : t('account.refresh')}
                                  </ButtonText>
                              </Button>
                              {/* The way out. This screen had NO exit at all,
                                  which was defensible while the app was
                                  unusable without a plan and is not now:
                                  companion mode is a legitimate place to be,
                                  and a dead end here would strand a user who
                                  has chosen it. */}
                              <Button
                                  testID="not-subscribed-continue"
                                  onPress={handleContinueWithoutPlan}
                                  variant="link"
                                  className="w-full"
                                  size="lg"
                              >
                                  <ButtonText className="text-gray-400">
                                      {t('companion.continueWithoutPlan')}
                                  </ButtonText>
                              </Button>
                          </VStack>
                      </Box>

                      <Text size="md" className="text-gray-400 text-center mt-4">
                          {t('account.enquiries')}{" "}
                          <TouchableOpacity onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}>
                              <Text size="md" className="text-primary-400">
                                  {t('account.contactEmail', { supportEmail: SUPPORT_EMAIL })}
                              </Text>
                          </TouchableOpacity>
                      </Text>
                  </VStack>
              </Box>
            </SafeAreaView>
        </View>
    );
}
