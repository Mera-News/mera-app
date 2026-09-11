import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { alpha3ToAlpha2 } from '@/components/custom/locations/location-display';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import {
    observeActive,
    type PublicationPrefKind,
} from '@/lib/database/services/publication-preference-service';
import {
    setSourcePrefFromUi,
    type SourcePrefUiLevel,
} from '@/lib/database/services/publication-pref-ui-actions';
import logger from '@/lib/logger';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import { MaterialIcons } from '@expo/vector-icons';
import { getSubscribedSourceNameSet, normalizeSubscriptionName } from '@/lib/database/services/user-publication-subscription-service';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList } from 'react-native';
import PublicationPrefRow from './PublicationPrefRow';
import SubscriptionsSection from './SubscriptionsSection';

interface PublicationPreferencesScreenProps {
    readonly onBack: () => void;
}

/** boost/deprioritize/none (item 9's shared vocabulary) — mute stays out of it. */
function levelForKind(kind: Exclude<PublicationPrefKind, 'mute'>): SourcePrefUiLevel {
    return kind === 'boost' ? 'prioritised' : 'deprioritised';
}

/**
 * Source-preferences screen (Wave 12; scope rows added source-pref P4;
 * boost/downrank/clear now shared with the L1/L2 ↑/↓ controls via
 * `publication-pref-ui-actions` — item 9, Wave B). A reactive list of the
 * publications AND source scopes (e.g. "prefer sources from India") the user
 * has explicitly adjusted (boost / downrank / mute), with per-row kind
 * switching and a clear affordance.
 *
 * `boost`/`deprioritize`/clear (named-publication AND scope) route through
 * `setSourcePrefFromUi` — the SAME module the L1 country list's and this
 * file's own L2 sibling's ↑/↓ controls call — so the 5-step dance
 * (guard → read `before` → apply → change-log → sweep) exists in exactly one
 * place instead of drifting between however many screens touch a preference.
 * `PublicationPreference.scopeValue` is stored ISO ALPHA-3; that module's
 * public boundary is alpha-2 (the convention every other caller already has
 * on hand), so a scope row's stored value is converted once, right here,
 * with `alpha3ToAlpha2` before the call — never inside the shared module and
 * never inside the store.
 *
 * `mute` is NOT part of that shared vocabulary (item 9: a downrank is not a
 * block, and muting is a hard exclusion that stays exclusive to this
 * dedicated screen's 3-way selector) — its branch below still calls
 * `applyPersonaAction` directly, unchanged from before this refactor.
 */
const PublicationPreferencesScreen: React.FC<PublicationPreferencesScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const [items, setItems] = useState<PublicationPreferenceModel[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    // Keyed on `pref.id`, not the display name/label — a scope row's label
    // ("India") can collide with a real publication called "India", which
    // would otherwise busy-lock the wrong row's chips.
    const [busyId, setBusyId] = useState<string | null>(null);
    // Every SOURCE name covered by an active subscription, normalised. Used to
    // keep a subscribed publication out of "Other sources" below.
    const [subscribedSourceNames, setSubscribedSourceNames] = useState<Set<string>>(new Set());

    useEffect(() => {
        let cancelled = false;
        void getSubscribedSourceNameSet().then((names) => {
            if (!cancelled) setSubscribedSourceNames(names);
        });
        return () => {
            cancelled = true;
        };
    }, [items]);

    /**
     * "Other sources" = every preference row NOT covered by a subscription.
     *
     * Matched against the subscription's SOURCE-name set, never against its
     * publisher name. A `publication_preferences` row is keyed by the source's
     * `publication_name`, and a source name is frequently not the publisher's
     * name, so comparing to the publisher name would leave the boosted row
     * visible in both sections. That is the same trap `source_names_json`
     * exists to prevent, one layer up.
     *
     * Scope rows (country predicates) are never suppressed: they are not a
     * publication and can never be a subscription.
     */
    const otherSources = useMemo(
        () =>
            items.filter(
                (p) =>
                    p.scopeKind != null ||
                    !subscribedSourceNames.has(normalizeSubscriptionName(p.publicationName)),
            ),
        [items, subscribedSourceNames],
    );

    useEffect(() => {
        const sub = observeActive().subscribe((rows) => {
            setItems(rows);
            setIsLoading(false);
        });
        return () => sub.unsubscribe();
    }, []);

    const handleSetKind = useCallback(async (pref: PublicationPreferenceModel, kind: PublicationPrefKind) => {
        setBusyId(pref.id);
        try {
            const scopeKind = pref.scopeKind;
            const scopeValue = pref.scopeValue;
            if (kind === 'mute') {
                // Mute stays OUTSIDE the shared L1/L2 ↑/↓ vocabulary (item 9) —
                // it is a hard exclusion, not a downrank, and this screen's 3-way
                // selector is its only surface. Unchanged from before this
                // refactor: a direct executor call. A scope row's `mute` press
                // reaches the executor too, which `skipped`s it (scopes can
                // never be muted) — same as before.
                if (scopeKind != null) {
                    if (!scopeValue) return;
                    await applyPersonaAction(
                        {
                            action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
                            scopeKind,
                            scopeValue,
                            scopeLabel: pref.publicationName,
                            publicationPref: 'mute',
                        },
                        'user',
                    );
                    return;
                }
                await applyPersonaAction(
                    {
                        action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
                        publicationId: pref.publicationName,
                        publicationPref: 'mute',
                    },
                    'user',
                );
                return;
            }
            // boost / deprioritize — shared with every L1/L2 ↑/↓ control now
            // (item 9): one call into publication-pref-ui-actions instead of
            // this screen's own copy of the apply dance.
            const level = levelForKind(kind);
            if (scopeKind != null) {
                if (!scopeValue) return;
                // Store is alpha-3; the shared module's boundary is alpha-2 —
                // convert exactly once, here, never inside the module or the
                // store (see the module's own header for why).
                const countryAlpha2 = alpha3ToAlpha2(scopeValue);
                if (!countryAlpha2) {
                    logger.captureException(new Error('unmappable scope alpha-3 code'), {
                        tags: { component: 'PublicationPreferencesScreen', method: 'setKind' },
                        extra: { prefId: pref.id, scopeValue },
                    });
                    return;
                }
                await setSourcePrefFromUi(
                    { kind: 'country', countryAlpha2, label: pref.publicationName },
                    level,
                );
                return;
            }
            await setSourcePrefFromUi({ kind: 'publication', publicationName: pref.publicationName }, level);
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'PublicationPreferencesScreen', method: 'setKind' },
                extra: { prefId: pref.id, kind },
            });
        } finally {
            setBusyId(null);
        }
    }, []);

    const handleClear = useCallback(async (pref: PublicationPreferenceModel) => {
        setBusyId(pref.id);
        try {
            const scopeKind = pref.scopeKind;
            const scopeValue = pref.scopeValue;
            if (scopeKind != null) {
                if (!scopeValue) return;
                const countryAlpha2 = alpha3ToAlpha2(scopeValue);
                if (!countryAlpha2) {
                    logger.captureException(new Error('unmappable scope alpha-3 code'), {
                        tags: { component: 'PublicationPreferencesScreen', method: 'clear' },
                        extra: { prefId: pref.id, scopeValue },
                    });
                    return;
                }
                await setSourcePrefFromUi(
                    { kind: 'country', countryAlpha2, label: pref.publicationName },
                    'none',
                );
                return;
            }
            await setSourcePrefFromUi({ kind: 'publication', publicationName: pref.publicationName }, 'none');
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'PublicationPreferencesScreen', method: 'clear' },
                extra: { prefId: pref.id },
            });
        } finally {
            setBusyId(null);
        }
    }, []);

    const renderItem = useCallback(
        ({ item }: { item: PublicationPreferenceModel }) => (
            <PublicationPrefRow
                pref={item}
                // `busy` is PublicationPrefRow's only disable input (drives
                // `disabled=` on the clear/kind Pressables), so folding
                // free-tier read-only into it disables the row without
                // threading a new prop into that child.
                busy={busyId === item.id}
                onSetKind={handleSetKind}
                onClear={handleClear}
            />
        ),
        [busyId, handleSetKind, handleClear],
    );

    return (
        // No opaque fill: the route mounts AbstractGradientBackdrop OUTSIDE
        // its SafeAreaView, so the page background spans the safe areas.
        <Box className="flex-1">
            <DrillDownHeader
                title={t('publicationPrefs.title', { defaultValue: 'Source preferences' })}
                subtitle={t('publicationPrefs.subtitle', { defaultValue: 'Boost, downrank or mute publications' })}
                onBack={onBack}
            />
            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : (
                <FlatList
                    data={otherSources}
                    keyExtractor={(item) => item.id}
                    renderItem={renderItem}
                    contentContainerStyle={{ paddingBottom: 48 }}
                    showsVerticalScrollIndicator={false}
                    // "Your subscriptions" is the list header rather than a
                    // sibling above the FlatList so the whole screen scrolls as
                    // one. It renders even when empty — the section is how the
                    // feature is found, and one that appears only once you
                    // already use it can never be discovered.
                    ListHeaderComponent={
                        <VStack space="xs">
                            <SubscriptionsSection />
                            <Text size="sm" className="text-gray-400 uppercase px-4 pt-4 pb-1">
                                {t('subscriptions.otherSources')}
                            </Text>
                        </VStack>
                    }
                    // Only the LOWER section's empty state. The screen as a
                    // whole is never empty now, because the subscriptions
                    // section always renders.
                    ListEmptyComponent={
                        <VStack className="items-center px-8 py-10" space="md">
                            <MaterialIcons name="tune" size={56} color="#666666" />
                            <Text size="md" className="text-gray-400 text-center">
                                {t('publicationPrefs.empty', {
                                    defaultValue: "You haven't adjusted any sources yet. Boost, downrank or mute a publication from any article to see it here.",
                                })}
                            </Text>
                        </VStack>
                    }
                />
            )}

        </Box>
    );
};

export default PublicationPreferencesScreen;
