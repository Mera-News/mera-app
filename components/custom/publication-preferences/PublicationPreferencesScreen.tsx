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
    observeActive,
    setPreferenceKind,
    type PublicationPrefKind,
} from '@/lib/database/services/publication-preference-service';
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
 * Source-preferences screen (Wave 12). A reactive list of the publications the
 * user has explicitly adjusted (boost / downrank / mute), with per-row kind
 * switching and a clear affordance. Concrete-kind changes route through the
 * persona-action executor so each lands an invertible persona_change_log row;
 * clears bypass the executor (which has no 'none' action) and append the
 * equivalent row manually — still fully invertible, since `before` records the
 * prior kind and revertChange restores it.
 */
const PublicationPreferencesScreen: React.FC<PublicationPreferencesScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const [items, setItems] = useState<PublicationPreferenceModel[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [busyName, setBusyName] = useState<string | null>(null);

    useEffect(() => {
        const sub = observeActive().subscribe((rows) => {
            setItems(rows);
            setIsLoading(false);
        });
        return () => sub.unsubscribe();
    }, []);

    const handleSetKind = useCallback(async (publicationName: string, kind: PublicationPrefKind) => {
        setBusyName(publicationName);
        try {
            await applyPersonaAction(
                {
                    action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
                    publicationId: publicationName,
                    publicationPref: kind,
                },
                'user',
            );
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'PublicationPreferencesScreen', method: 'setKind' },
                extra: { publicationName, kind },
            });
        } finally {
            setBusyName(null);
        }
    }, []);

    const handleClear = useCallback(async (publicationName: string) => {
        setBusyName(publicationName);
        try {
            // The executor has no 'none' action, so clears run the service
            // directly + append the change-log row by hand. Fully invertible:
            // `before` carries the prior kind and revertChange's
            // set_publication_pref case restores it.
            const before = await getPreferenceKind(publicationName);
            await setPreferenceKind(publicationName, 'none', 'user');
            await changeLogService.append({
                actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
                action: { targetId: publicationName, before, after: 'none' },
                source: 'user',
                summary: `Cleared publication preference: ${publicationName}`,
            });
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'PublicationPreferencesScreen', method: 'clear' },
                extra: { publicationName },
            });
        } finally {
            setBusyName(null);
        }
    }, []);

    const renderItem = useCallback(
        ({ item }: { item: PublicationPreferenceModel }) => (
            <PublicationPrefRow
                pref={item}
                busy={busyName === item.publicationName}
                onSetKind={handleSetKind}
                onClear={handleClear}
            />
        ),
        [busyName, handleSetKind, handleClear],
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
