import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableData, TableRow } from '@/components/ui/table';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { fetchUserBilling } from '@/lib/billing-service';
import type { UserBillingInfo } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { getActiveEntitlementInfo, getActiveTier, getCustomerInfoSafe, getOfferingSafe } from '@/lib/revenuecat';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import RevenueCatUI from 'react-native-purchases-ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const TD_CLS = 'px-3 py-2 border-b border-gray-800';
const ROW_EVEN = 'bg-black';
const ROW_ODD = 'bg-gray-950';

const SectionHeader = ({ title }: { title: string }) => (
    <Box className="pt-5 pb-1.5 border-b border-gray-800 mb-2">
        <Text size="xs" className="text-gray-500 uppercase tracking-widest font-semibold">
            {title}
        </Text>
    </Box>
);

// 2-column key/value table (same layout as ObservabilityScreen's KVTable)
const KVTable = ({ rows }: { rows: [string, string][] }) => (
    <Box className="rounded-xl overflow-hidden border border-gray-800">
        <Table className="w-full">
            <TableBody>
                {rows.map(([k, v], i) => (
                    <TableRow key={k} className={i % 2 === 0 ? ROW_EVEN : ROW_ODD}>
                        <TableData useRNView className={TD_CLS} style={{ flex: 1 }}>
                            <Text size="xs" className="text-gray-400">{k}</Text>
                        </TableData>
                        <TableData useRNView className={TD_CLS} style={{ flex: 1 }}>
                            <Text size="xs" className="text-white text-right" numberOfLines={1}>{v}</Text>
                        </TableData>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    </Box>
);

interface ManageSubscriptionScreenProps {
    onBack?: () => void;
}

/**
 * Subscription details + actions: plan and daily article limit from our DB
 * (the source of truth), entitlement details and price from RevenueCat, and
 * the two RevenueCat UI flows (paywall to view/upgrade plans, Customer Center
 * to manage/cancel). Each data source degrades independently — a failed
 * billing fetch hides the DB rows, an unconfigured RevenueCat hides the
 * entitlement rows.
 */
const ManageSubscriptionScreen: React.FC<ManageSubscriptionScreenProps> = ({ onBack }) => {
    const { t, i18n } = useTranslation();
    const insets = useSafeAreaInsets();
    const [billing, setBilling] = useState<UserBillingInfo | null>(null);
    const [priceString, setPriceString] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const customerInfo = useSubscriptionStore((s) => s.customerInfo);
    const setCustomerInfo = useSubscriptionStore((s) => s.setCustomerInfo);

    const rcTier = getActiveTier(customerInfo);
    const activeEntitlement = getActiveEntitlementInfo(customerInfo);

    useEffect(() => {
        const load = async () => {
            const [billingInfo, freshCustomerInfo, offering] = await Promise.all([
                fetchUserBilling(),
                getCustomerInfoSafe(),
                getOfferingSafe(),
            ]);
            setBilling(billingInfo);
            if (freshCustomerInfo) setCustomerInfo(freshCustomerInfo);

            // Price lives on the offering's packages, not on CustomerInfo —
            // match the active entitlement's product to a package.
            const info = freshCustomerInfo ?? useSubscriptionStore.getState().customerInfo;
            const productId = getActiveEntitlementInfo(info)?.productIdentifier ?? null;
            if (productId && offering) {
                const pkg = offering.availablePackages.find(
                    (p) =>
                        p.product.identifier === productId ||
                        // Android product ids can carry a ":basePlan" suffix.
                        p.product.identifier.startsWith(`${productId}:`) ||
                        productId.startsWith(`${p.product.identifier}:`),
                );
                setPriceString(pkg?.product.priceString ?? null);
            }
            setLoading(false);
        };
        void load();
    }, [setCustomerInfo]);

    const handleViewPlans = async () => {
        try {
            const offering = await getOfferingSafe();
            // Browsing/upgrading from settings — show a close button so the user
            // can dismiss without purchasing (unlike the hard gate).
            await RevenueCatUI.presentPaywall({
                ...(offering ? { offering } : {}),
                displayCloseButton: true,
            });
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'ManageSubscriptionScreen', method: 'viewPlans' },
            });
        }
    };

    const handleCustomerCenter = async () => {
        try {
            await RevenueCatUI.presentCustomerCenter();
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'ManageSubscriptionScreen', method: 'customerCenter' },
            });
        }
    };

    const formatDate = (iso: string | null | undefined): string | null => {
        if (!iso) return null;
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return null;
        return date.toLocaleString(i18n.language, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    };

    const planName = (tier: string | null | undefined): string => {
        if (tier === 'professional') return t('subscription.planProfessional');
        if (tier === 'individual') return t('subscription.planIndividual');
        return t('subscription.planPromo');
    };

    const periodTypeLabel = (periodType: string): string => {
        switch (periodType) {
            case 'NORMAL': return t('subscription.periodNormal');
            case 'TRIAL': return t('subscription.periodTrial');
            case 'INTRO': return t('subscription.periodIntro');
            case 'PROMOTIONAL': return t('subscription.periodPromotional');
            default: return periodType;
        }
    };

    const storeLabel = (store: string): string => {
        switch (store) {
            case 'APP_STORE': return t('subscription.storeAppStore');
            case 'PLAY_STORE': return t('subscription.storePlayStore');
            case 'PROMOTIONAL': return t('subscription.storePromotional');
            default: return store;
        }
    };

    // DB is the source of truth for the plan; fall back to the RC tier while
    // the webhook sync is still catching up.
    const effectiveTier = billing?.subscriptionTier && billing.subscriptionTier !== 'none'
        ? billing.subscriptionTier
        : rcTier;

    const planRows: [string, string][] = [
        [t('subscription.planLabel'), planName(effectiveTier)],
        ...(priceString ? [[t('subscription.priceLabel'), priceString] as [string, string]] : []),
    ];

    const usageRows: [string, string][] = billing
        ? [
            [t('subscription.dailyArticleLimit'), String(billing.dailyArticleLimit)],
            [t('subscription.usedToday'), String(billing.articlesUsedToday)],
            ...((formatDate(billing.resetAt))
                ? [[t('subscription.resetsOn'), new Date(billing.resetAt).toLocaleString(i18n.language, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })] as [string, string]]
                : []),
        ]
        : [];

    const entitlementRows: [string, string][] = activeEntitlement
        ? [
            [
                activeEntitlement.willRenew ? t('subscription.renewsOn') : t('subscription.expiresOn'),
                formatDate(activeEntitlement.expirationDate) ?? t('subscription.lifetime'),
            ],
            [t('subscription.autoRenew'), activeEntitlement.willRenew ? t('common.yes') : t('common.no')],
            [t('subscription.periodLabel'), periodTypeLabel(activeEntitlement.periodType)],
            [t('subscription.storeLabel'), storeLabel(activeEntitlement.store)],
        ]
        : [];

    return (
        <Box className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
            <HStack className="px-4 py-3 items-center">
                <Pressable onPress={onBack} className="bg-gray-900 rounded-full p-2" hitSlop={8}>
                    <MaterialIcons name="arrow-back" size={20} color="#ffffff" />
                </Pressable>
                <Text className="text-white font-semibold text-base flex-1 text-center mr-9">
                    {t('subscription.managePlan')}
                </Text>
            </HStack>

            {loading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : (
                <ScrollView
                    className="flex-1"
                    contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
                    showsVerticalScrollIndicator={false}
                >
                    <SectionHeader title={t('subscription.planSection')} />
                    <KVTable rows={planRows} />

                    {usageRows.length > 0 && (
                        <>
                            <SectionHeader title={t('subscription.usageSection')} />
                            <KVTable rows={usageRows} />
                        </>
                    )}

                    {entitlementRows.length > 0 && (
                        <>
                            <SectionHeader title={t('subscription.detailsSection')} />
                            <KVTable rows={entitlementRows} />
                        </>
                    )}

                    <VStack space="md" className="mt-8">
                        <Button onPress={handleViewPlans} className="w-full">
                            <ButtonText>{t('subscription.viewPlans')}</ButtonText>
                        </Button>
                        <Button variant="outline" action="secondary" onPress={handleCustomerCenter} className="w-full">
                            <ButtonText>{t('subscription.customerCenter')}</ButtonText>
                        </Button>
                    </VStack>
                </ScrollView>
            )}
        </Box>
    );
};

export default ManageSubscriptionScreen;
