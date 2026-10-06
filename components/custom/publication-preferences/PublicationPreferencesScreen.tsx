import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { alpha3ToAlpha2 } from '@/components/custom/locations/location-display';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import type { PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import { setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';
import logger from '@/lib/logger';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList } from 'react-native';
import PublicationPrefRow from './PublicationPrefRow';
import { setPublisherKind } from './set-publisher-kind';
import SourceSearch from './SourceSearch';
import SubscriptionsSection from './SubscriptionsSection';
import { useAdjustedSources } from './use-adjusted-sources';

interface PublicationPreferencesScreenProps {
    readonly onBack: () => void;
}

/**
 * You > Profile > Sources: the one place for publication preferences. Search
 * ("Find a publication"), the Adjusted list (More, Fewer, Muted), then the
 * publications you pay for. Mute moved here from Not interested, and "Fewer
 * from" in an article's menu lands here.
 *
 * A country scope row ("prefer sources from India") converts its stored
 * alpha-3 to alpha-2 exactly once, here, before the shared writer; it can
 * never be muted, so its row offers no Mute.
 */
const PublicationPreferencesScreen: React.FC<PublicationPreferencesScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const { rows, isLoading } = useAdjustedSources();
    const bottom = useTabBarClearance();
    // Keyed on `pref.id`, never the label: a scope "India" and a publication
    // called "India" must not lock each other.
    const [busyId, setBusyId] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);

    const namesById = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const { group, pref } of rows) map.set(pref.id, group.names.length > 0 ? group.names : [pref.publicationName]);
        return map;
    }, [rows]);
    const namesRef = useRef(namesById);
    namesRef.current = namesById;
    /** Every name the row's publication is written under (its group). */
    const namesOf = useCallback(
        (pref: PublicationPreferenceModel) => namesRef.current.get(pref.id) ?? [pref.publicationName],
        [],
    );

    /** A scope row's country target, or null when its stored code is unusable. */
    const countryTarget = (pref: PublicationPreferenceModel, method: string) => {
        if (!pref.scopeValue) return null;
        const countryAlpha2 = alpha3ToAlpha2(pref.scopeValue);
        if (!countryAlpha2) {
            logger.captureException(new Error('unmappable scope alpha-3 code'), {
                tags: { component: 'PublicationPreferencesScreen', method },
                extra: { prefId: pref.id, scopeValue: pref.scopeValue },
            });
            return null;
        }
        return { kind: 'country' as const, countryAlpha2, label: pref.publicationName };
    };

    const handleSetKind = useCallback(async (pref: PublicationPreferenceModel, kind: PublicationPrefKind) => {
        setBusyId(pref.id);
        try {
            if (pref.scopeKind == null) {
                await setPublisherKind(namesOf(pref), kind);
                return;
            }
            if (kind === 'mute') {
                // A scope can never be muted; the executor skips it (no UI offers it).
                if (!pref.scopeValue) return;
                await applyPersonaAction(
                    {
                        action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
                        scopeKind: pref.scopeKind,
                        scopeValue: pref.scopeValue,
                        scopeLabel: pref.publicationName,
                        publicationPref: 'mute',
                    },
                    'user',
                );
                return;
            }
            const target = countryTarget(pref, 'setKind');
            if (target) await setSourcePrefFromUi(target, kind === 'boost' ? 'prioritised' : 'deprioritised');
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'PublicationPreferencesScreen', method: 'setKind' },
                extra: { prefId: pref.id, kind },
            });
        } finally {
            setBusyId(null);
        }
        // countryTarget is a plain helper with no state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [namesOf]);

    const handleClear = useCallback(async (pref: PublicationPreferenceModel) => {
        setBusyId(pref.id);
        try {
            if (pref.scopeKind == null) {
                // Clearing a publication clears EVERY name in its group.
                await setSourcePrefFromUi({ kind: 'publisher', names: namesOf(pref) }, 'none');
            } else {
                const target = countryTarget(pref, 'clear');
                if (target) await setSourcePrefFromUi(target, 'none');
            }
            setOpenId(null);
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'PublicationPreferencesScreen', method: 'clear' },
                extra: { prefId: pref.id },
            });
        } finally {
            setBusyId(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [namesOf]);

    const handleToggle = useCallback((pref: PublicationPreferenceModel) => {
        setOpenId((prev) => (prev === pref.id ? null : pref.id));
    }, []);

    const renderItem = useCallback(
        ({ item }: { item: { pref: PublicationPreferenceModel } }) => (
            <PublicationPrefRow
                pref={item.pref}
                busy={busyId === item.pref.id}
                isOpen={openId === item.pref.id}
                onToggle={handleToggle}
                onSetKind={handleSetKind}
                onClear={handleClear}
            />
        ),
        [busyId, openId, handleToggle, handleSetKind, handleClear],
    );

    return (
        // No opaque fill: the route mounts the page backdrop.
        <Box className="flex-1">
            <DrillDownHeader title={t('you.sources.title')} onBack={onBack} />
            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : (
                <FlatList
                    data={rows}
                    keyExtractor={(item) => item.group.key}
                    renderItem={renderItem}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ paddingTop: 8, paddingBottom: bottom + 24 }}
                    showsVerticalScrollIndicator={false}
                    ListHeaderComponent={
                        <VStack>
                            <SourceSearch />
                            {rows.length > 0 ? (
                                <Text size="sm" className="text-gray-400 font-bold px-4 pt-3 pb-2" accessibilityRole="header">
                                    {t('you.sources.adjusted')}
                                </Text>
                            ) : (
                                <Text testID="sources-empty" size="sm" className="text-gray-300 px-4 py-3">
                                    {t('you.sources.empty')}
                                </Text>
                            )}
                        </VStack>
                    }
                    ListFooterComponent={
                        <VStack space="md">
                            {rows.length > 0 ? (
                                <Text size="xs" className="text-gray-400 px-4">
                                    {t('you.sources.footnote')}
                                </Text>
                            ) : null}
                            {/* Always shown: the section is how the feature is found. */}
                            <SubscriptionsSection />
                        </VStack>
                    }
                />
            )}
        </Box>
    );
};

export default PublicationPreferencesScreen;
