import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import * as changeLogService from '@/lib/database/services/persona-change-log-service';
import {
    getPreferenceKind,
    getScopePreferenceKind,
    observeActive,
    setPreferenceKind,
    setScopePreferenceKind,
    type PublicationPrefKind,
    type SourceScopeRef,
} from '@/lib/database/services/publication-preference-service';
import { markFeedNeedsRefresh, runSweepFor, sweepForMutation } from '@/lib/database/services/persona-mutation-sweeps';
import logger from '@/lib/logger';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList } from 'react-native';
import PublicationPrefRow from './PublicationPrefRow';

interface PublicationPreferencesScreenProps {
    readonly onBack: () => void;
}

/**
 * source-pref P4 (planned, not yet wired): once Phase 3 lands
 * `ACTION_NAMES.SET_SOURCE_SCOPE_PREF` in `persona-action-executor.ts`, the
 * scope branches below should route through `applyPersonaAction` exactly like
 * the named-publication branch does, and this literal should become that
 * constant. Kept as a literal (not imported) because `action-names.ts` is
 * owned by that concurrent change.
 */
const SET_SOURCE_SCOPE_PREF_ACTION_TYPE = 'set_source_scope_pref';

/**
 * Source-preferences screen (Wave 12; scope rows added source-pref P4). A
 * reactive list of the publications AND source scopes (e.g. "prefer sources
 * from India") the user has explicitly adjusted (boost / downrank / mute),
 * with per-row kind switching and a clear affordance.
 *
 * Named-publication concrete-kind changes route through the persona-action
 * executor so each lands an invertible persona_change_log row; clears bypass
 * the executor (which has no 'none' action) and append the equivalent row
 * manually — still fully invertible, since `before` records the prior kind
 * and revertChange restores it. A hand-appended clear also runs the same
 * retroactive sweep the executor would have run (source-pref P4 fix — see
 * `handleClear` below): without it, un-muting a publication from this screen
 * left the articles the mute had hard-excluded invisible forever.
 *
 * Scope rows have no executor action yet (`TODO(source-pref P3)` below) —
 * both branches hand-append their change-log row the same way clears do. A
 * scope is never a hard filter (`stage-scoring.ts` explicitly skips scope
 * rows when deriving hard suppressions), so there is nothing to sweep; only
 * `markFeedNeedsRefresh` is needed to trigger a rescore.
 */
const PublicationPreferencesScreen: React.FC<PublicationPreferencesScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const [items, setItems] = useState<PublicationPreferenceModel[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    // Keyed on `pref.id`, not the display name/label — a scope row's label
    // ("India") can collide with a real publication called "India", which
    // would otherwise busy-lock the wrong row's chips.
    const [busyId, setBusyId] = useState<string | null>(null);

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
            if (scopeKind != null) {
                if (!scopeValue) return;
                // source-pref P5: routed through the executor now that
                // ACTION_NAMES.SET_SOURCE_SCOPE_PREF exists, replacing this
                // branch's hand-append. The executor owns the change-log row,
                // the sweep decision and the D18 dirty-marking, so a chip tap
                // here and a confirmed chat proposal now travel the exact same
                // path — which is what keeps the Activity undo for both of them
                // reading from one inverse implementation.
                await applyPersonaAction(
                    {
                        action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
                        scopeKind,
                        scopeValue,
                        scopeLabel: pref.publicationName,
                        publicationPref: kind,
                    },
                    'user',
                );
                return;
            }
            await applyPersonaAction(
                {
                    action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
                    publicationId: pref.publicationName,
                    publicationPref: kind,
                },
                'user',
            );
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
                const scope: SourceScopeRef = { scopeKind, scopeValue };
                // TODO(source-pref P3): same hand-off as handleSetKind above —
                // once the executor grows a 'none' path for
                // SET_SOURCE_SCOPE_PREF this should call applyPersonaAction too.
                const before = await getScopePreferenceKind(scope);
                await setScopePreferenceKind(scope, 'none', pref.publicationName, 'user');
                await changeLogService.append({
                    actionType: SET_SOURCE_SCOPE_PREF_ACTION_TYPE,
                    action: { targetId: `${scopeKind}:${scopeValue}`, before, after: 'none' },
                    source: 'user',
                    summary: `Cleared source-scope preference: ${pref.publicationName}`,
                });
                // No sweep possible (scopes never hard-filter) — just a rescore.
                markFeedNeedsRefresh();
                return;
            }
            // The executor has no 'none' action, so clears run the service
            // directly + append the change-log row by hand. Fully invertible:
            // `before` carries the prior kind and revertChange's
            // set_publication_pref case restores it.
            const before = await getPreferenceKind(pref.publicationName);
            await setPreferenceKind(pref.publicationName, 'none', 'user');
            await changeLogService.append({
                actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
                action: { targetId: pref.publicationName, before, after: 'none' },
                source: 'user',
                summary: `Cleared publication preference: ${pref.publicationName}`,
            });
            // source-pref P4 fix: this hand-append used to stop here, so
            // un-muting from this screen ran no un-exclude sweep — the
            // articles a mute had hard-excluded stayed invisible even though
            // the screen showed the preference gone. Run exactly the sweep +
            // dirty-flag policy `applyPersonaAction` runs for
            // SET_PUBLICATION_PREF (see persona-action-executor.ts), via the
            // same shared policy module, so a hand-appended clear reconciles
            // the feed identically to an executor-routed change.
            const purged = await runSweepFor(
                sweepForMutation({
                    actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
                    prefBefore: before,
                    prefAfter: 'none',
                }),
                ACTION_NAMES.SET_PUBLICATION_PREF,
            );
            if (!purged) markFeedNeedsRefresh();
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
                busy={busyId === item.id}
                onSetKind={handleSetKind}
                onClear={handleClear}
            />
        ),
        [busyId, handleSetKind, handleClear],
    );

    return (
        <Box className="flex-1 bg-black">
            <DrillDownHeader
                title={t('publicationPrefs.title', { defaultValue: 'Source preferences' })}
                subtitle={t('publicationPrefs.subtitle', { defaultValue: 'Boost, downrank or mute publications' })}
                onBack={onBack}
            />
            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : items.length === 0 ? (
                <VStack className="flex-1 items-center justify-center px-8" space="md">
                    <MaterialIcons name="tune" size={56} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {t('publicationPrefs.empty', {
                            defaultValue: "You haven't adjusted any sources yet. Boost, downrank or mute a publication from any article to see it here.",
                        })}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(item) => item.id}
                    renderItem={renderItem}
                    contentContainerStyle={{ paddingBottom: 48 }}
                    showsVerticalScrollIndicator={false}
                />
            )}
        </Box>
    );
};

export default PublicationPreferencesScreen;
