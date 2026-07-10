import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
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
import UsageWidget from '../UsageWidget';
import { humanizeKey } from './observability-labels';
import { useThemeColors } from '@/lib/theme/tokens';

const SectionHeader = ({ title }: { title: string }) => (
    <Box className="pt-6 pb-2">
        <Text size="xs" className="text-typography-400 uppercase tracking-widest font-semibold">
            {title}
        </Text>
    </Box>
);

const StatusPill = ({ text, color }: { text: string; color: string }) => (
    <HStack space="xs" className="items-center self-start bg-background-100 rounded-full px-2.5 py-1 mt-3">
        <Box style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
        <Text size="xs" className="text-typography-700">{text}</Text>
    </HStack>
);

const InfoRow = ({ icon, label, value, isLast }: { icon: keyof typeof MaterialIcons.glyphMap; label: string; value: string; isLast?: boolean }) => {
    const colors = useThemeColors();
    return (
        <HStack className={`items-center px-4 py-3 ${isLast ? '' : 'border-b border-outline-50'}`}>
            <MaterialIcons name={icon} size={16} color={colors.iconMuted} />
            <Text size="sm" className="text-typography-500 ml-3 flex-1">{label}</Text>
            <Text size="sm" className="text-typography-950" numberOfLines={1}>{value}</Text>
        </HStack>
    );
};

interface ManageSubscriptionScreenProps {
    onBack?: () => void;
}

/**
 * Subscription details + actions: plan and daily article limit from our DB
 * (the source of truth), entitlement details and price from RevenueCat, and
 * the two RevenueCat UI flows (paywall to view/upgrade plans, Customer Center
 * to manage/cancel). Each data source degrades independently — a failed
 * billing fetch hides the usage/plan rows, an unconfigured RevenueCat hides
 * the entitlement rows.
 */
const ManageSubscriptionScreen: React.FC<ManageSubscriptionScreenProps> = ({ onBack }) => {
    const { t, i18n } = useTranslation();
    const insets = useSafeAreaInsets();
    const colors = useThemeColors();
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
            default: return humanizeKey(periodType);
        }
    };

    const storeLabel = (store: string): string => {
        switch (store) {
            case 'APP_STORE': return t('subscription.storeAppStore');
            case 'PLAY_STORE': return t('subscription.storePlayStore');
            case 'PROMOTIONAL': return t('subscription.storePromotional');
            default: return humanizeKey(store);
        }
    };

    // DB is the source of truth for the plan; fall back to the RC tier while
    // the webhook sync is still catching up.
    const effectiveTier = billing?.subscriptionTier && billing.subscriptionTier !== 'none'
        ? billing.subscriptionTier
        : rcTier;

    const isPaid = effectiveTier === 'individual' || effectiveTier === 'professional';

    // Glanceable status pill for the hero card.
    const statusPill: { text: string; color: string } | null = activeEntitlement
        ? (() => {
            const date = formatDate(activeEntitlement.expirationDate);
            if (!date) return { text: t('subscription.lifetime'), color: colors.success };
            const prefix = activeEntitlement.willRenew
                ? t('subscription.renewsOn')
                : t('subscription.expiresOn');
            return { text: `${prefix} ${date}`, color: activeEntitlement.willRenew ? colors.success : colors.warning };
        })()
        : isPaid
            ? { text: t('subscription.active'), color: colors.success }
            : null;

    const usedToday = billing?.articlesUsedToday ?? 0;
    const dailyLimit = billing?.dailyArticleLimit ?? 0;

    const detailRows: { icon: keyof typeof MaterialIcons.glyphMap; label: string; value: string }[] = activeEntitlement
        ? [
            {
                icon: activeEntitlement.willRenew ? 'event-available' : 'event-busy',
                label: activeEntitlement.willRenew ? t('subscription.renewsOn') : t('subscription.expiresOn'),
                value: formatDate(activeEntitlement.expirationDate) ?? t('subscription.lifetime'),
            },
            {
                icon: 'autorenew',
                label: t('subscription.autoRenew'),
                value: activeEntitlement.willRenew ? t('common.yes') : t('common.no'),
            },
            { icon: 'schedule', label: t('subscription.periodLabel'), value: periodTypeLabel(activeEntitlement.periodType) },
            { icon: 'store', label: t('subscription.storeLabel'), value: storeLabel(activeEntitlement.store) },
        ]
        : [];

    return (
        <Box className="flex-1 bg-background-0" style={{ paddingTop: insets.top }}>
            <HStack className="px-4 py-3 items-center">
                <Pressable onPress={onBack} className="bg-background-50 rounded-full p-2" hitSlop={8}>
                    <MaterialIcons name="arrow-back" size={20} color={colors.icon} />
                </Pressable>
                <Text className="text-typography-950 font-semibold text-base flex-1 text-center mr-9">
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
                    {/* Hero plan card */}
                    <Box className="bg-background-50 rounded-2xl p-5 border border-outline-50 mt-4">
                        <HStack className="items-center">
                            <Box className="bg-background-100 rounded-full p-2.5">
                                <MaterialIcons
                                    name={isPaid ? 'workspace-premium' : 'person-outline'}
                                    size={22}
                                    color={isPaid ? colors.warning : colors.iconMuted}
                                />
                            </Box>
                            <VStack className="ml-3 flex-1">
                                <Text size="xs" className="text-typography-400">{t('subscription.planLabel')}</Text>
                                <Text className="text-typography-950 font-bold text-2xl leading-8">
                                    {isPaid ? planName(effectiveTier) : t('subscription.freePlan')}
                                </Text>
                            </VStack>
                            {priceString ? (
                                <Text className="text-typography-950 font-semibold text-lg">{priceString}</Text>
                            ) : null}
                        </HStack>
                        {statusPill ? <StatusPill text={statusPill.text} color={statusPill.color} /> : null}
                    </Box>

                    {/* Usage */}
                    {billing && (
                        <>
                            <SectionHeader title={t('subscription.usageSection')} />
                            <UsageWidget
                                used={usedToday}
                                limit={dailyLimit}
                                usedLabel={t('subscription.usedToday')}
                                planLabel={isPaid ? planName(effectiveTier) : t('subscription.freePlan')}
                                onUpgrade={effectiveTier === 'professional' ? undefined : handleViewPlans}
                                upgradeLabel={t('subscription.upgrade')}
                                resetAt={billing.resetAt}
                                resetLabel={t('subscription.resetsOn')}
                            />
                        </>
                    )}

                    {/* Subscription details */}
                    {detailRows.length > 0 && (
                        <>
                            <SectionHeader title={t('subscription.detailsSection')} />
                            <Box className="bg-background-50 rounded-2xl border border-outline-50 overflow-hidden">
                                {detailRows.map((row, i) => (
                                    <InfoRow
                                        key={row.label}
                                        icon={row.icon}
                                        label={row.label}
                                        value={row.value}
                                        isLast={i === detailRows.length - 1}
                                    />
                                ))}
                            </Box>
                        </>
                    )}

                    <VStack space="md" className="mt-8">
                        <Button onPress={handleViewPlans} className="w-full">
                            <MaterialIcons name="upgrade" size={18} color={colors.onPrimary} />
                            <ButtonText>{t('subscription.viewPlans')}</ButtonText>
                        </Button>
                        <Button variant="outline" action="secondary" onPress={handleCustomerCenter} className="w-full">
                            <MaterialIcons name="settings" size={18} color={colors.icon} />
                            <ButtonText>{t('subscription.customerCenter')}</ButtonText>
                        </Button>
                    </VStack>
                </ScrollView>
            )}
        </Box>
    );
};

export default ManageSubscriptionScreen;
