import FactCheckCard from '@/components/custom/fact-checks/FactCheckCard';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    DASHBOARD_FACT_CHECK_PREVIEW,
    useFactCheckItems,
} from '@/lib/stores/fact-checks-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/**
 * The Dashboard's "Fact checks" block — the surface that makes an asynchronous
 * fact check useful.
 *
 * The detail panel now fires a request and stops; the answer arrives minutes
 * later. Without somewhere to see the answers, "we'll tell you when it's done"
 * would be a promise with no destination. This is the destination.
 *
 * It is deliberately NOT a `SectionKind` in `lib/stores/fact-rows-selector`.
 * That type describes sections OF ARTICLES and `DashboardSectionsFeed` renders
 * `FactRow`s through the whole scoring/ordering pipeline; a fact check is a
 * different kind of object entirely and threading it through that pipeline
 * would break the section machinery for a purely presentational adjacency.
 *
 * RENDERS NOTHING when there are no stored checks — an empty "Fact checks"
 * heading at the top of every Dashboard would be permanent chrome for a feature
 * most sessions never touch. The empty state lives on the full-list screen,
 * where the user arrived on purpose.
 */
const DashboardFactChecksBlock: React.FC = () => {
    const { t } = useTranslation();
    const items = useFactCheckItems();
    // Sliced HERE, not in the zustand selector: a `.slice()` inside the selector
    // allocates a new array per store read and `Object.is` would never match.
    const recent = useMemo(
        () => items.slice(0, DASHBOARD_FACT_CHECK_PREVIEW),
        [items],
    );

    if (recent.length === 0) return null;

    return (
        <VStack space="sm" className="mb-4" testID="dashboard-fact-checks">
            <HStack className="items-center justify-between">
                <HStack space="xs" className="items-center flex-1">
                    <MaterialIcons name="fact-check" size={16} color={ACCENT} />
                    <Text size="sm" className="text-gray-300 font-semibold ml-1">
                        {t('factCheck.dashboard.title')}
                    </Text>
                </HStack>
                <Pressable
                    onPress={() => router.push('/logged-in/fact-checks')}
                    accessibilityRole="button"
                    accessibilityLabel={t('factCheck.dashboard.viewAll')}
                    testID="dashboard-fact-checks-view-all"
                    hitSlop={8}
                >
                    <Text size="sm" className="text-primary-400 font-semibold">
                        {t('factCheck.dashboard.viewAll')}
                    </Text>
                </Pressable>
            </HStack>

            {recent.map((item) => (
                <FactCheckCard
                    key={item.id}
                    item={item}
                    testIDPrefix="dashboard-fact-check"
                />
            ))}
        </VStack>
    );
};

export default DashboardFactChecksBlock;
