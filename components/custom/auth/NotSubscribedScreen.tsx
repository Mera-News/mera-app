import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from "@/components/custom/MeraLogo";
import { CardGlassPlate } from "@/components/custom/cards/CardGlassPlate";
import { Box } from "@/components/ui/box";
import { Button, ButtonIcon, ButtonText } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { RepeatIcon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { VStack } from "@/components/ui/vstack";
import { authClient } from "@/lib/auth-client";
import { SUPPORT_EMAIL } from "@/lib/config/branding";
import { fetchUserBilling } from "@/lib/billing-service";
import { setSetting } from "@/lib/database/services/setting-service";
// From the leaf module, NOT from FirstOpenPaywallGate: that component pulls in
// LapseInterstitialGate → billing-service → apollo-client → the WatermelonDB
// singleton, an entire dependency chain this screen imported solely to read one
// string constant.
import { FIRST_OPEN_DISMISSED_SETTING_KEY } from "@/lib/subscription/first-open-dismissal";
import logger from "@/lib/logger";
import {
    getCustomerInfoSafe,
    getOfferingSafe,
    getTrialAvailability,
    isRevenueCatConfigured,
    logRevenueCatDiagnostics,
    type TrialAvailability,
} from "@/lib/revenuecat";
import { useSubscriptionStore } from "@/lib/stores/subscription-store";
import { useUserStore } from "@/lib/stores/user-store";
import { showSubscriptionActivatedToast } from "@/lib/subscription/activation-toast";
import { syncEntitlement } from "@/lib/subscription/entitlement-sync";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, TouchableOpacity, View } from "react-native";
// Via the ui layer rather than `react-native` directly: it is the same
// component, and every other screen's test can stub one module path instead of
// partially mocking the whole react-native module.
import { ScrollView } from "@/components/ui/scroll-view";
import RevenueCatUI, { PAYWALL_RESULT } from "react-native-purchases-ui";
import { SafeAreaView } from "react-native-safe-area-context";

export interface NotSubscribedScreenProps {
    /**
     * `'lapsed'` — the user HAD a plan and it ended. Its own copy: Mera News
     * Free is genuinely FOR this user, because there is a device full of saved
     * articles, followed stories and reading history for it to preserve.
     *
     * `undefined` — the first-open case, also what the first-open push routes
     * to. Different copy for the opposite reason: a never-subscribed user has
     * nothing accumulated for Mera News Free to keep yet, so Starter is the
     * honest recommendation.
     *
     * NEITHER mode auto-presents the purchase sheet any more — see the note on
     * `presentPaywall`.
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

    // Seeded `'unknown'` on purpose, which renders the no-trial copy and the
    // "Subscribe now" label. The store answer arrives a beat after mount, and the
    // safe thing to show in that beat is the version that promises less: a CTA
    // that says "Start your free trial" and then flips to "Subscribe now" has
    // already made an offer we cannot take back.
    const [trialAvailability, setTrialAvailability] =
        useState<TrialAvailability>('unknown');

    useEffect(() => {
        let cancelled = false;
        // Lapsed users are not shown the trial paragraph or label at all, so
        // there is nothing to ask the store about.
        if (isLapsed) return;
        void getTrialAvailability().then((a) => {
            if (!cancelled) setTrialAvailability(a);
        });
        return () => {
            cancelled = true;
        };
    }, [isLapsed]);

    // Local-first, per lib/security/launch-route.ts. `checkServerSubscribed`
    // below is the only way off this screen other than Mera News Free, and with
    // the id read off the session it returned false WITHOUT asking the server
    // whenever /get-session could not be reached — so Refresh did nothing at
    // all for a user who had genuinely just paid. The query it makes is
    // authorised by the auth cookie, not by this object, so the persisted id is
    // the right key for it; the session remains the fallback for the window
    // before hydrateFromDb() has run.
    const localUserId = useUserStore((s) => s.userId);
    const userId = localUserId ?? session?.user?.id;

    // The server is the source of truth — but it has to be ASKED ABOUT BILLING.
    //
    // This used to call `getUserPersona()` and return true whenever it did not
    // throw, on the theory that the query 402s until the tier syncs. It does
    // not: `userPersonaByUserId` carries NO SubscriptionGuard server-side and is
    // declared `nullable: true`, so it answers 200 for everyone, and
    // `AccountService.getUserPersona` returns `null` rather than throwing when
    // no persona exists. So this predicate was true for EVERY caller, including
    // a brand-new user who had just paid and whose webhook had not landed yet.
    //
    // That is what made a successful purchase bounce straight back to this
    // screen. The sequence: poll says "subscribed" on its first tick →
    // `leaveForRouterGate()` → `/logged-in` → the pre-onboarding gate re-reads
    // `aiAccess`, still `'locked'` because the tier genuinely had not arrived →
    // `decideOnboardingEntry` returns `'paywall'` → back here. `leaveForRouterGate`
    // even documents that exact loop and calls `syncEntitlement` to prevent it,
    // but no sync can invent a tier the server has not written yet. The bug was
    // never the sync; it was leaving too early on a predicate that never said no.
    //
    // Reading `userBilling` directly is the honest question, and it is the same
    // fact `deriveAiAccess` keys on, so "we may leave" and "the gate will let us
    // through" can no longer disagree. `fetchUserBilling` returns null (never
    // throws) on a failed read, which correctly reads as "not yet".
    const checkServerSubscribed = useCallback(async (): Promise<boolean> => {
        if (!userId) return false;
        const billing = await fetchUserBilling();
        return billing != null && billing.subscriptionTier !== 'none';
    }, [userId]);

    /**
     * Leave for the router gate, having first made the subscription store agree
     * with the server we just proved is subscribed.
     *
     * The forced sync is load-bearing, and it is the same trap
     * `present-free-tier-paywall.ts` documents at length: `deriveAiAccess`
     * consults `serverTier` FIRST and reads 'none' as locked, so a store still
     * holding the PRE-purchase 'none' outranks RevenueCat's freshly-updated
     * customerInfo. Without this, a user who has genuinely just paid arrives at
     * /logged-in still looking locked — and the pre-onboarding paywall gate
     * would send them straight back to this screen, in a loop.
     *
     * No retry budget needed here, unlike the free-tier path: we only get here
     * once `checkServerSubscribed()` has already returned true, which means the
     * webhook has landed and a single read sees the real tier.
     */
    const leaveForRouterGate = useCallback(async () => {
        // Captured BEFORE the sync, which overwrites serverTier with the
        // post-purchase value — read after, the pair would be the same value
        // twice and the toast's own none→paid check could never fire.
        const previousTier = useSubscriptionStore.getState().serverTier;
        await syncEntitlement({ force: true });
        // ONE outcome per confirmation, never two. Reaching here means
        // `checkServerSubscribed()` already returned 200 — the same standard as
        // `refreshUserBillingAfterPurchase`'s `confirmed: true` — so the pending
        // notice is retired in the same breath the success is announced.
        // Without the clear, a user whose activation resolved late would get the
        // toast while "your purchase is being confirmed" was still on screen.
        setMessage(null);
        showSubscriptionActivatedToast(
            previousTier,
            useSubscriptionStore.getState().serverTier,
        );
        router.replace('/logged-in');
    }, [router]);

    // After a purchase, the RevenueCat webhook updates the server tier
    // asynchronously — poll a few times before falling back to a manual refresh.
    // This budget only started mattering when `checkServerSubscribed` was fixed:
    // while that predicate was unconditionally true, the loop always returned on
    // its FIRST tick and the remaining attempts were dead code. Now the loop
    // genuinely waits for the webhook, so the budget is the difference between
    // landing in onboarding and landing on "your purchase is being confirmed".
    //
    // Sized to match `refreshUserBillingAfterPurchase`'s ~25s envelope rather
    // than the 12s this had, and for the same reason billing-service documents:
    // the server makes its own outbound REST call back to RevenueCat before it
    // writes Mongo, on top of RevenueCat's dispatch delay.
    const pollUntilSubscribed = useCallback(async (): Promise<boolean> => {
        for (let i = 0; i < 12; i++) {
            if (await checkServerSubscribed()) {
                await leaveForRouterGate();
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return false;
    }, [checkServerSubscribed, leaveForRouterGate]);

    /**
     * Open the purchase sheet. ONLY from an explicit tap.
     *
     * THIS REVERSES A DELIBERATE EARLIER DECISION — do not "fix" it back. The
     * original plan called the first-open case the primary conversion moment and
     * auto-presented the sheet on mount, softening only the `lapsed` path. The
     * owner overrode that: this screen now carries its own visible, unambiguous
     * plans CTA, so stacking a modal on top of it the instant the screen appears
     * is redundant — the user is shown the sheet before they can read the page
     * that was supposed to convince them, and dismissing it drops them onto a
     * screen they never chose to be on.
     */
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

    // NOTE: there is deliberately no auto-present effect here any more. It used
    // to fire on mount for every non-`lapsed` entry. See `presentPaywall` above
    // for why it was removed and by whom — restoring it would re-introduce the
    // modal-over-the-page behaviour the owner rejected.

    // Drop into the app on Mera News Free. `replace`, not `push`: this screen
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
            await leaveForRouterGate();
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
              {/* Scrollable, not a fixed centered Box: the panel now carries a
                  recommendation line and three actions, which overflows a small
                  phone at large accessibility text sizes. `flexGrow: 1` keeps it
                  optically centered whenever it does fit. */}
              <ScrollView
                  contentContainerStyle={{
                      flexGrow: 1,
                      justifyContent: 'center',
                      alignItems: 'center',
                      paddingHorizontal: 24,
                      paddingVertical: 24,
                  }}
                  showsVerticalScrollIndicator={false}
              >
                  <VStack space="lg" className="items-center w-full max-w-md">
                      {/* Glass panel, same two-Box construction as FreeTierCard /
                          NoGeneratedInterestsCard: the shadow lives on the outer,
                          non-clipping Box because RN drops a shadow the moment a
                          view sets overflow:hidden, and the rounded/clipped
                          surface is the inner one. `CardGlassPlate` is a
                          translucent fill, NOT a GlassView — no blur infra. */}
                      <Box className="w-full rounded-3xl shadow-hard-2">
                          <Box className="rounded-3xl overflow-hidden border border-white/10">
                              <CardGlassPlate />
                              <Box className="w-full items-center px-6 py-8">
                                  {/* The app's existing animated-logo treatment —
                                      MeraLogo's own `animated` spotlight sweep,
                                      the same one the floating chat bubble and
                                      AllCaughtUpCard use. Not a new animation.
                                      Sized down from 112: the copy below is now a
                                      three-paragraph note rather than one line, and
                                      the logo was spending vertical space the
                                      argument needs. */}
                                  <Box className="items-center mb-4">
                                      <MeraLogo size={72} animated />
                                  </Box>

                                  <Heading size="3xl" className="text-white text-center">
                                      {isLapsed ? t('freeTier.lapseTitle') : t('subscription.title')}
                                  </Heading>

                                  {/* Deliberately a plain run of paragraphs, not a
                                      lead line plus a bordered callout. This is
                                      meant to read top to bottom as one note from
                                      us to the reader; boxing the last third of an
                                      argument turns it into a side-note and breaks
                                      exactly the continuity the copy is going for. */}
                                  {isLapsed ? (
                                      <>
                                          <Text size="md" className="text-gray-300 text-center leading-relaxed mt-3">
                                              {t('freeTier.lapseBody')}
                                          </Text>
                                          <Text size="md" className="text-gray-300 text-center leading-relaxed mt-4">
                                              {t('subscription.lapsedFreeNote')}
                                          </Text>
                                      </>
                                  ) : (
                                      <>
                                          <Text size="md" className="text-gray-300 text-center leading-relaxed mt-3">
                                              {t('subscription.para1')}
                                          </Text>
                                          <Text size="md" className="text-gray-300 text-center leading-relaxed mt-4">
                                              {t('subscription.para2')}
                                          </Text>
                                          {/* The trial paragraph is NOT unconditional.
                                              Only `mera_news_individual_monthly` on the
                                              App Store carries an introductory offer, so
                                              on Android — and for anyone who has already
                                              used theirs — recommending "the one week
                                              free trial" would promise something the
                                              store will refuse at the sheet. */}
                                          <Text size="md" className="text-gray-300 text-center leading-relaxed mt-4">
                                              {trialAvailability === 'eligible'
                                                  ? t('subscription.para3Trial')
                                                  : t('subscription.para3NoTrial')}
                                          </Text>
                                      </>
                                  )}

                                  {message ? (
                                      <Text size="sm" className="text-primary-400 text-center mt-4">
                                          {message}
                                      </Text>
                                  ) : null}

                                  {/* Descending weight, and now descending SIZE too:
                                      one solid CTA, then two quiet text links.
                                      Refresh sits directly under the CTA because it
                                      is the recovery path for the CTA itself (a
                                      purchase that went through but has not landed
                                      yet), so it belongs next to the thing it
                                      recovers. */}
                                  <VStack space="sm" className="w-full mt-6">
                                      <Button
                                          testID="not-subscribed-plans"
                                          onPress={presentPaywall}
                                          disabled={busy}
                                          className="bg-primary-500 w-full rounded-full"
                                          size="lg"
                                      >
                                          {busy ? <Spinner size="small" className="mr-2" /> : null}
                                          <ButtonText className="text-white font-semibold">
                                              {isLapsed
                                                  ? t('subscription.turnMeraBackOn')
                                                  : trialAvailability === 'eligible'
                                                      ? t('subscription.startFreeTrial')
                                                      : t('subscription.subscribeNow')}
                                          </ButtonText>
                                      </Button>

                                      <Button
                                          testID="not-subscribed-refresh"
                                          onPress={handleRefresh}
                                          disabled={busy}
                                          variant="link"
                                          className="w-full rounded-full"
                                          size="md"
                                      >
                                          <ButtonIcon as={RepeatIcon} className="mr-2 text-gray-400" />
                                          <ButtonText className="text-gray-400">
                                              {busy ? t('common.checking') : t('account.refresh')}
                                          </ButtonText>
                                      </Button>

                                      {/* Demoted from an outlined button to a link,
                                          but the rules that governed it are unchanged
                                          and still load-bearing: Mera News Free is a
                                          legitimate destination, not an escape hatch
                                          to be hidden, and this is the ONLY way off
                                          the screen. So it stays never disabled (even
                                          while `busy` holds for ~12s, which would
                                          otherwise strand a user behind a request they
                                          did not ask for), never guilt-worded, and at
                                          the same size as Refresh rather than smaller
                                          — subordinate by weight, not by legibility. */}
                                      <Button
                                          testID="not-subscribed-continue"
                                          onPress={handleContinueWithoutPlan}
                                          variant="link"
                                          className="w-full rounded-full"
                                          size="md"
                                      >
                                          <ButtonText className="text-gray-400 underline">
                                              {t('freeTier.continueWithoutPlan')}
                                          </ButtonText>
                                      </Button>
                                  </VStack>
                              </Box>
                          </Box>
                      </Box>

                      <Text size="sm" className="text-gray-400 text-center">
                          {t('account.enquiries')}{" "}
                          <TouchableOpacity onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}>
                              <Text size="sm" className="text-primary-400">
                                  {t('account.contactEmail', { supportEmail: SUPPORT_EMAIL })}
                              </Text>
                          </TouchableOpacity>
                      </Text>
                  </VStack>
              </ScrollView>
            </SafeAreaView>
        </View>
    );
}
