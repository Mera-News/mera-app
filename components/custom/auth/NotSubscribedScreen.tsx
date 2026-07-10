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
import logger from "@/lib/logger";
import {
    getCustomerInfoSafe,
    getOfferingSafe,
    isRevenueCatConfigured,
    logRevenueCatDiagnostics,
} from "@/lib/revenuecat";
import { useSubscriptionStore } from "@/lib/stores/subscription-store";
import { useThemeColors } from "@/lib/theme/tokens";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, TouchableOpacity } from "react-native";
import RevenueCatUI, { PAYWALL_RESULT } from "react-native-purchases-ui";
import { SafeAreaView } from "react-native-safe-area-context";

export default function NotSubscribedScreen() {
    const { data: session, isPending: isSessionPending } = authClient.useSession();
    const router = useRouter();
    const { t } = useTranslation();
    const colors = useThemeColors();
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
    useEffect(() => {
        if (!presentedRef.current && userId && isRevenueCatConfigured()) {
            presentedRef.current = true;
            void presentPaywall();
        }
    }, [userId, presentPaywall]);

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
            <Box className="flex-1 justify-center items-center bg-background-0">
                <Spinner size="large" />
            </Box>
        );
    }

    return (
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
            <Box className="flex-1 justify-center items-center bg-background-0 px-6">
                <VStack space="xl" className="items-center max-w-md">
                    <Box className="items-center mb-8">
                        <MeraLogo size={150} />
                    </Box>
                    <Heading size="2xl" className="text-typography-950 text-center">
                        {t('subscription.title')}
                    </Heading>

                    <Text size="lg" className="text-typography-700 text-center leading-relaxed">
                        {t('subscription.description')}
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
                                <ButtonText className="text-typography-950">
                                    {busy ? t('common.checking') : t('account.refresh')}
                                </ButtonText>
                            </Button>
                        </VStack>
                    </Box>

                    <Text size="md" className="text-typography-500 text-center mt-4">
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
    );
}
