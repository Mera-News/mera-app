import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { HEADLINE_DEPTH_UI_ENABLED } from '@/lib/config/feature-gates';
import { getHeadlineDepths } from '@/lib/database/services/headline-depth-service';
import { getAll as getAllLocations } from '@/lib/database/services/location-service';
import { hapticLight } from '@/lib/haptics';
import type LocationModel from '@/lib/database/models/Location';
import logger from '@/lib/logger';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { toastManager } from '@/lib/toast-manager';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { countryNameForAlpha2, flagForAlpha2 } from '../locations/location-display';
import {
    chooseHeadlineDepth,
    DEFAULT_HEADLINE_LIMIT_PER_SCOPE,
    headlineDepthOptions,
    headlineScopeRows,
    type HeadlineScopeRow,
} from './headline-depth-model';

const ACCENT = '#EDA77E';
const SUBTLE = 'rgb(163,163,163)';

const OPTIONS = headlineDepthOptions();

interface HeadlineDepthScreenProps {
    readonly onBack: () => void;
}

/**
 * "How many top headlines should Mera read for me?", per section.
 *
 * One collapsed row per section the feed sync actually asks for — the countries
 * derived from the reader's locations, then Worldwide — each showing its current
 * number. Opening a row reveals a short ladder of choices; the shipped default
 * is marked, and picking it removes the override rather than pinning the value.
 * Collapsed-with-a-count is the same disclosure shape as the Not-interested
 * screen, so nothing here is a wall until you ask for it.
 *
 * Gated: while `HEADLINE_DEPTH_UI_ENABLED` is false this screen renders nothing
 * and the row that pushes it is not drawn. The route is deep-linkable, and a
 * live control writing rows that `getHeadlineDepths` refuses to read would be a
 * setting that visibly does nothing.
 */
const HeadlineDepthScreen: React.FC<HeadlineDepthScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();

    const [isLoading, setIsLoading] = useState(true);
    const [scopes, setScopes] = useState<readonly HeadlineScopeRow[]>([]);
    const [depths, setDepths] = useState<Record<string, number>>({});
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    const [busyKey, setBusyKey] = useState<string | null>(null);

    const load = useCallback(async () => {
        const [locations, stored] = await Promise.all([
            getAllLocations(),
            getHeadlineDepths(),
        ]);
        setScopes(
            headlineScopeRows(
                locations.map((l: LocationModel) => ({
                    countryCode: l.countryCode,
                    role: l.role,
                    weight: l.weight,
                    validUntilMs: l.validUntil ?? undefined,
                })),
            ),
        );
        setDepths(stored);
    }, []);

    useEffect(() => {
        if (!HEADLINE_DEPTH_UI_ENABLED) return;
        let cancelled = false;
        load()
            .catch((error) => {
                logger.captureException(error, {
                    tags: { component: 'HeadlineDepthScreen', method: 'load' },
                });
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [load]);

    const handleChoose = useCallback(
        async (scopeKey: string, depth: number) => {
            if (busyKey) return;
            setBusyKey(scopeKey);
            void hapticLight();
            // Optimistic: the ladder is a radio, and waiting on SQLite before
            // moving the selection reads as an unresponsive tap.
            setDepths((prev) => {
                const next = { ...prev };
                if (depth === DEFAULT_HEADLINE_LIMIT_PER_SCOPE) delete next[scopeKey];
                else next[scopeKey] = depth;
                return next;
            });
            try {
                await chooseHeadlineDepth(scopeKey, depth);
                // Depth only takes effect on the NEXT retrieval, so without a
                // signal the reader walks back to an unchanged feed and reads
                // the setting as broken. Flag it rather than syncing inline —
                // a feed-sync per chip tap is worse than the silence it fixes.
                // This lights the glow on the Advanced hub's refresh button the
                // reader just walked past, whose hint already explains it.
                useForYouStore.getState().setFeedNeedsRefresh(true);
            } catch (error) {
                logger.captureException(error, {
                    tags: { component: 'HeadlineDepthScreen', method: 'choose' },
                    extra: { scopeKey, depth },
                });
                toastManager.showError(
                    t('headlineDepth.saveFailedTitle'),
                    t('headlineDepth.saveFailedBody'),
                );
                // Re-read rather than reverting by hand — storage is the truth.
                await load().catch(() => { /* keep the optimistic value */ });
            } finally {
                setBusyKey(null);
            }
        },
        [busyKey, load, t],
    );

    if (!HEADLINE_DEPTH_UI_ENABLED) return null;

    const scopeLabel = (scope: HeadlineScopeRow): string =>
        scope.isGlobal
            ? t('headlineDepth.worldwide')
            : countryNameForAlpha2(scope.countryCode) || scope.countryCode;

    const scopeGlyph = (scope: HeadlineScopeRow): string =>
        scope.isGlobal ? '🌍' : flagForAlpha2(scope.countryCode);

    return (
        <Box testID="headline-depth-screen" className="flex-1 bg-black">
            <DrillDownHeader
                title={t('headlineDepth.title')}
                subtitle={t('headlineDepth.subtitle')}
                onBack={onBack}
            />

            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : (
                <ScrollView
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingTop: 8, paddingBottom: 64 }}
                >
                    <HStack className="mx-4 mt-2 mb-3 items-start" space="xs">
                        <MaterialIcons
                            name="auto-awesome"
                            size={14}
                            color="#93c5fd"
                            style={{ marginTop: 2 }}
                        />
                        <Text size="xs" className="text-gray-400 flex-1 leading-relaxed">
                            {t('headlineDepth.intro')}
                        </Text>
                    </HStack>

                    {scopes.map((scope) => {
                        const current = depths[scope.key] ?? DEFAULT_HEADLINE_LIMIT_PER_SCOPE;
                        const isExpanded = expandedKey === scope.key;
                        const glyph = scopeGlyph(scope);
                        const label = scopeLabel(scope);
                        return (
                            <View key={scope.key} className="mb-1">
                                <Pressable
                                    testID={`headline-depth-scope-${scope.key}`}
                                    onPress={() =>
                                        setExpandedKey((prev) => (prev === scope.key ? null : scope.key))
                                    }
                                    accessibilityRole="button"
                                    accessibilityLabel={label}
                                    accessibilityState={{ expanded: isExpanded }}
                                    className="flex-row items-center px-4 py-3 border-b border-gray-800"
                                >
                                    {glyph ? <Text className="text-xl mr-2">{glyph}</Text> : null}
                                    <Text size="md" className="text-white flex-1 mr-2" numberOfLines={1}>
                                        {label}
                                    </Text>
                                    <View
                                        testID={`headline-depth-scope-${scope.key}-value`}
                                        className="rounded-full px-2 py-0.5 mr-1 bg-gray-700"
                                    >
                                        <Text size="xs" style={{ color: SUBTLE }}>
                                            {current}
                                        </Text>
                                    </View>
                                    <MaterialIcons
                                        name={isExpanded ? 'expand-less' : 'expand-more'}
                                        size={20}
                                        color="#9ca3af"
                                    />
                                </Pressable>

                                {isExpanded ? (
                                    <VStack className="px-4 py-3" space="sm">
                                        <HStack space="sm" className="flex-wrap">
                                            {OPTIONS.map((option) => {
                                                const selected = option === current;
                                                return (
                                                    <Pressable
                                                        key={option}
                                                        testID={`headline-depth-option-${scope.key}-${option}`}
                                                        onPress={() => handleChoose(scope.key, option)}
                                                        disabled={busyKey !== null}
                                                        accessibilityRole="radio"
                                                        accessibilityState={{ selected }}
                                                        accessibilityLabel={t('headlineDepth.optionLabel', { n: option })}
                                                        className={`rounded-full px-3 py-1.5 mb-2 border ${selected ? 'border-transparent' : 'border-gray-700'
                                                            }`}
                                                        style={
                                                            selected ? { backgroundColor: ACCENT } : undefined
                                                        }
                                                    >
                                                        <Text
                                                            size="sm"
                                                            className={selected ? 'text-black' : 'text-gray-300'}
                                                        >
                                                            {t('headlineDepth.optionLabel', { n: option })}
                                                        </Text>
                                                    </Pressable>
                                                );
                                            })}
                                        </HStack>
                                        <Text size="xs" className="text-gray-500 leading-relaxed">
                                            {current === DEFAULT_HEADLINE_LIMIT_PER_SCOPE
                                                ? t('headlineDepth.usingDefault', { n: DEFAULT_HEADLINE_LIMIT_PER_SCOPE })
                                                : t('headlineDepth.customised', { n: DEFAULT_HEADLINE_LIMIT_PER_SCOPE })}
                                        </Text>
                                    </VStack>
                                ) : null}
                            </View>
                        );
                    })}
                </ScrollView>
            )}
        </Box>
    );
};

export default HeadlineDepthScreen;
