import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import GlassPanel from "@/components/custom/cards/GlassPanel";
import { Box } from "@/components/ui/box";
import { Button, ButtonIcon, ButtonText } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { HelpCircleIcon, RepeatIcon } from "@/components/ui/icon";
import { HStack } from "@/components/ui/hstack";
import { Spinner } from "@/components/ui/spinner";
import { Pressable } from "@/components/ui/pressable";
import { useSupportAction } from "@/lib/intercom";
import { Text } from "@/components/ui/text";
import { VStack } from "@/components/ui/vstack";
import { authClient } from "@/lib/auth-client";
import { MaterialIcons } from "@expo/vector-icons";
import { fetchUserBilling } from "@/lib/billing-service";
import { setSetting } from "@/lib/database/services/setting-service";
// From the leaf module, NOT from FirstOpenPaywallGate: that component pulls in
// LapseInterstitialGate → billing-service → apollo-client → the WatermelonDB
// singleton, an entire dependency chain this screen imported solely to read one
// string constant.
import { FIRST_OPEN_DISMISSED_SETTING_KEY } from "@/lib/subscription/first-open-dismissal";
import logger from "@/lib/logger";
import { ensureEmailBeforeCheckout } from "@/lib/subscription/email-capture";
import {
    getCustomerInfoSafe,
    getOfferingSafe,
    isRevenueCatConfigured,
    logRevenueCatDiagnostics,
} from "@/lib/revenuecat";
import { useSubscriptionStore } from "@/lib/stores/subscription-store";
import { useUserStore } from "@/lib/stores/user-store";
import { showSubscriptionActivatedToast } from "@/lib/subscription/activation-toast";
import { syncEntitlement } from "@/lib/subscription/entitlement-sync";
import { isSandboxPurchaseOnProduction } from "@/lib/subscription/sandbox-environment-mismatch";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
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
    const { busy: supportBusy, openSupport } = useSupportAction();
    const [busy, setBusy] = useState(false);
    // Which control owns the current `busy` window. `busy` gates BOTH the CTA
    // and Refresh, and now that Refresh is icon-only it has no label left to
    // swap to "Checking…" — so without this the spinner would appear on the
    // primary CTA while the work the reader actually started was the refresh
    // beside it, pointing the only progress indicator at the wrong control.
    const [refreshing, setRefreshing] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    // r13: the store-eligibility probe that used to live here is gone with the
    // trial itself. There is no introductory offer to promise any more — the
    // free period is the server's 14-day Starter grant, which this screen only
    // ever renders AFTER (it is a day-15+ surface now).

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
        // S10: verified email is required before checkout for anonymous
        // accounts; a dismissed sheet aborts quietly (the screen stays up).
        if (!(await ensureEmailBeforeCheckout())) return;
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

                // A SANDBOX purchase on a PRODUCTION-backed build can never be
                // confirmed, so do not spend the poll's retry budget pretending
                // it might. RevenueCat routes sandbox receipts to the staging
                // webhook by configuration, which means the UserBilling row this
                // poll waits for is being written into a database this build
                // does not read. Polling would burn ~20 attempts and then land
                // on "your purchase is being confirmed" — a message that is
                // false in both halves. Tell the tester the actual rule instead.
                if (isSandboxPurchaseOnProduction(info)) {
                    logger.warn(
                        'sandbox purchase on a production backend — poll skipped',
                        { component: 'NotSubscribedScreen' },
                    );
                    setMessage(t('subscription.sandboxOnProduction'));
                    return;
                }

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

    /**
     * Explain the one state this screen cannot resolve, instead of showing a
     * paywall to somebody the App Store already considers a subscriber.
     *
     * The gate is deliberately server-authoritative: `checkServerSubscribed`
     * reads `UserBilling.subscriptionTier`, and `deriveAiAccess` consults the
     * server tier FIRST, so a local RevenueCat entitlement cannot unlock the app
     * on its own. That is correct — the device must not be able to grant itself
     * a paid tier — but it means a SANDBOX purchase on a PRODUCTION build
     * produces a genuinely contradictory screen: StoreKit says "you are
     * currently subscribed to this", and Mera says "Free isn't free".
     *
     * Both are telling the truth. RevenueCat routes sandbox receipts to the
     * STAGING webhook by configuration, so the row this screen waits for is
     * written into a database this build never queries.
     *
     * Checked on MOUNT and on REFRESH, not only after a purchase: a tester who
     * bought on a previous launch arrives here with the entitlement already on
     * the device and never passes through the purchase path at all — which is
     * exactly the report that prompted this.
     */
    const checkSandboxMismatch = useCallback(async (): Promise<boolean> => {
        if (!isRevenueCatConfigured()) return false;
        const info = await getCustomerInfoSafe();
        if (!isSandboxPurchaseOnProduction(info)) return false;
        logger.warn('sandbox entitlement on a production backend', {
            component: 'NotSubscribedScreen',
        });
        setMessage(t('subscription.sandboxOnProduction'));
        return true;
    }, [t]);

    useEffect(() => {
        void checkSandboxMismatch();
    }, [checkSandboxMismatch]);

    const handleRefresh = async () => {
        setBusy(true);
        setRefreshing(true);
        setMessage(null);
        if (await checkServerSubscribed()) {
            await leaveForRouterGate();
        } else {
            // Refresh used to fail SILENTLY — it cleared `busy` and said nothing,
            // so the reader could not tell a slow webhook from an impossible one.
            // Name the impossible case; leave the ordinary one to `activationDelayed`.
            if (!(await checkSandboxMismatch())) {
                setMessage(t('subscription.activationDelayed'));
            }
            setBusy(false);
            setRefreshing(false);
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
                      {/* Same panel `FreeTierCard` renders — see `GlassPanel`
                          for the two-Box shadow/clip construction and why it's
                          shaped that way. Adopting it here (rather than keeping
                          a parallel copy) is what proves the extraction is
                          real. */}
                      <GlassPanel radius="3xl" logoSize={72} className="w-full" contentClassName="px-6 py-8">
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
                                          <Text size="md" className="text-gray-300 text-center leading-relaxed mt-4">
                                              {t('freeTier.lapseBody')}
                                          </Text>
                                          <Text size="md" className="text-gray-300 text-center leading-relaxed mt-4">
                                              {t('subscription.lapsedFreeNote')}
                                          </Text>
                                      </>
                                  ) : (
                                      <>
                                          <Text size="md" className="text-gray-300 text-center leading-relaxed mt-4">
                                              {t('subscription.para1')}
                                          </Text>
                                          <Text size="md" className="text-gray-300 text-center leading-relaxed mt-4">
                                              {t('subscription.para2')}
                                          </Text>
                                          {/* Unconditional since r13: the store trial is
                                              gone, so there is no eligibility to branch
                                              on and nothing to promise the sheet would
                                              then refuse. */}
                                          <Text size="md" className="text-gray-300 text-center leading-relaxed mt-4">
                                              {t('subscription.para3NoTrial')}
                                          </Text>
                                      </>
                                  )}

                                  {message ? (
                                      <Text size="sm" className="text-primary-400 text-center mt-4">
                                          {message}
                                      </Text>
                                  ) : null}

                                  {/* Descending weight: one solid CTA, then an
                                      outlined secondary, then one quiet text link.
                                      Refresh sits ON the CTA's own row because it
                                      is the recovery path for the CTA itself (a
                                      purchase that went through but has not landed
                                      yet), so it belongs beside the thing it
                                      recovers. */}
                                  <VStack space="sm" className="w-full mt-6">
                                      {/* Three columns, and the leading one is a
                                          SPACER that mirrors the trailing icon
                                          button exactly — same `w-11`, same `gap-2`
                                          on either side of the middle column. That
                                          is what keeps the CTA's centre the PANEL's
                                          centre: it does not shift left to make room
                                          for Refresh. A margin would only fake this,
                                          and would drift the moment either side's
                                          size changed. */}
                                      <Box className="w-full flex-row items-center gap-2">
                                          <Box className="w-11" />

                                          <Button
                                              testID="not-subscribed-plans"
                                              onPress={presentPaywall}
                                              disabled={busy}
                                              // `h-auto min-h-11` rather than `lg`'s fixed
                                              // h-11: the CTA is ~104pt narrower now that
                                              // it shares a row, and its longest label
                                              // ("Turn Mera back on", longer still in
                                              // several locales) wraps to two lines on a
                                              // small phone at large Dynamic Type. A fixed
                                              // height would CLIP that second line; this
                                              // grows instead, while min-h keeps the 44pt
                                              // floor.
                                              className="bg-primary-500 flex-1 rounded-full h-auto min-h-11 py-2.5"
                                              size="lg"
                                          >
                                              {busy && !refreshing ? <Spinner size="small" className="mr-2" /> : null}
                                              <ButtonText className="text-white font-semibold">
                                                  {isLapsed
                                                      ? t('subscription.turnMeraBackOn')
                                                      : t('subscription.subscribeNow')}
                                              </ButtonText>
                                          </Button>

                                          {/* ICON ONLY. The label it lost is carried
                                              by `accessibilityLabel`, so the
                                              accessible name is unchanged — losing
                                              the visible text must not lose the
                                              name, and it also still announces
                                              "Checking…" while the poll runs.
                                              `w-11 h-11` is 44x44pt — Apple's HIG
                                              minimum — BEFORE the hitSlop, which is
                                              added anyway because the glyph itself is
                                              far smaller than its box. Those two
                                              classes are also what the leading spacer
                                              mirrors, so they must stay in step. */}
                                          <Button
                                              testID="not-subscribed-refresh"
                                              onPress={handleRefresh}
                                              disabled={busy}
                                              variant="link"
                                              size="lg"
                                              accessibilityRole="button"
                                              accessibilityLabel={busy ? t('common.checking') : t('account.refresh')}
                                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                              className="w-11 h-11 rounded-full items-center justify-center"
                                          >
                                              {refreshing
                                                  ? <Spinner size="small" />
                                                  : <ButtonIcon as={RepeatIcon} className="text-gray-300" />}
                                          </Button>
                                      </Box>

                                      {/* Between Refresh and Continue, and that
                                          position is the argument: this screen's
                                          job is to convince, and a reader who is
                                          not convinced has two ways out — one
                                          soft ("show me what this actually is")
                                          and one hard ("skip the plan"). The
                                          soft one belongs first, so it is offered
                                          before the escape hatch rather than
                                          after it, while the solid primary CTA
                                          keeps its monopoly on visual weight.
                                          Not `disabled={busy}`, for the same
                                          reason Continue is not: nothing here
                                          should be stranded behind a ~25s poll
                                          the reader never asked for.

                                          `/tutorials` is a TOP-LEVEL route — it
                                          has to be, because this screen is one of
                                          the places a reader has no plan and may
                                          have no session either. */}
                                      {/* OUTLINED, not a bare text link, and `lg` to
                                          match the CTA's h-11 (=44pt) — the two
                                          buttons read as one stack rather than a
                                          button and a stray link, and both clear
                                          Apple's 44pt minimum without a hitSlop.
                                          Gluestack's outline variant inherits
                                          `border-primary-300`, which is invisible
                                          against this glass panel, so the border and
                                          the text colour are both set explicitly. */}
                                      <Button
                                          testID="not-subscribed-learn"
                                          onPress={() => router.push('/tutorials' as any)}
                                          variant="outline"
                                          className="w-full rounded-full border-white/30"
                                          size="lg"
                                      >
                                          <ButtonIcon as={HelpCircleIcon} className="mr-2 text-white" />
                                          <ButtonText className="text-white">
                                              {t('tutorials.learnAboutMera')}
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
                                          the same size as the buttons above it rather
                                          than smaller — subordinate by weight, not by
                                          legibility. `lg` is also what puts its touch
                                          target on 44pt: a link variant has no fill,
                                          so the row height IS the target. */}
                                      <Button
                                          testID="not-subscribed-continue"
                                          onPress={handleContinueWithoutPlan}
                                          variant="link"
                                          className="w-full rounded-full"
                                          size="lg"
                                      >
                                          <ButtonText className="text-gray-400 underline">
                                              {t('freeTier.continueWithoutPlan')}
                                          </ButtonText>
                                      </Button>
                                  </VStack>
                      </GlassPanel>

                      {/* ONE support affordance, no email address on screen.
                          The support address used to render here as a mailto
                          fallback for builds without an Intercom key; support
                          is Intercom now, so the button is unconditional and
                          openSupport() itself degrades to the Mail app when
                          the Messenger cannot initialise (useSupportAction's
                          contract) — the label reads true either way. */}
                      <VStack space="xs" className="items-center">
                          {/* Compact outline pill sized to its label — the
                              support affordance everywhere except the settings
                              menu, which keeps its row (deliberate exception).
                              py-3 keeps the target in the 44pt class. */}
                          <Pressable
                              onPress={() => { void openSupport(); }}
                              accessibilityRole="button"
                              accessibilityState={supportBusy ? { busy: true } : undefined}
                              accessibilityLabel={
                                  supportBusy ? t('support.opening') : t('account.contactSupport')
                              }
                              className="self-center rounded-full border border-primary-500 bg-transparent px-5 py-3"
                          >
                              {supportBusy ? (
                                  <Spinner size="small" />
                              ) : (
                                  <HStack space="xs" className="items-center">
                                      {/* Material support_agent, tinted with the
                                          dark-ramp primary literal (same as the
                                          language selector's icon tint). */}
                                      <MaterialIcons name="support-agent" size={18} color="rgb(237, 167, 126)" />
                                      <Text size="sm" className="text-primary-500 font-semibold text-center">
                                          {t('account.contactSupport')}
                                      </Text>
                                  </HStack>
                              )}
                          </Pressable>
                      </VStack>
                  </VStack>
              </ScrollView>
            </SafeAreaView>
        </View>
    );
}
