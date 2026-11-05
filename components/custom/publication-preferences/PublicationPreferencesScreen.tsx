import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { alpha3ToAlpha2, flagForAlpha2 } from '@/components/custom/locations/location-display';
import PublicationControlRow from './PublicationControlRow';
import PublicationListRow from '@/components/custom/publication-page/PublicationListRow';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { router } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';
import SourceSearch from './SourceSearch';
import { localizedCountryName } from './country-search';
import { usePublicationRowPrefs } from './use-publication-row-prefs';
import { useAdjustedSources, type AdjustedSource, type TaggedPublication } from './use-adjusted-sources';

interface PublicationPreferencesScreenProps {
    readonly onBack: () => void;
}

type Item = { readonly type: 'publication'; readonly pub: TaggedPublication } | { readonly type: 'scope'; readonly scope: AdjustedSource };

const TAG_KEY: Record<'boost' | 'mute', 'publicationPage.preferred' | 'publicationPage.notPreferred'> = {
    boost: 'publicationPage.preferred',
    mute: 'publicationPage.notPreferred',
};

/**
 * You > Settings > Sources: search ("Find a publication"), then ONE list of
 * every publication the reader has tagged (Subscribed, Preferred, Not preferred).
 * A row opens the publication page, where every tag is set. A preferred
 * country is the shared row at the end and opens the country page; a scope
 * converts its stored alpha-3 to alpha-2 exactly once, here, and can never be
 * muted.
 */
const PublicationPreferencesScreen: React.FC<PublicationPreferencesScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const { publications, scopes, isLoading } = useAdjustedSources();
    const endClearance = useListEndClearance();
    const [searching, setSearching] = useState(false);
    const appLanguage = useAppLanguage();
    const prefs = usePublicationRowPrefs();

    const items = useMemo<Item[]>(
        () => [
            ...publications.map((pub) => ({ type: 'publication' as const, pub })),
            ...scopes.map((scope) => ({ type: 'scope' as const, scope })),
        ],
        [publications, scopes],
    );

    const renderItem = useCallback(
        ({ item }: { item: Item }) => {
            if (item.type === 'scope') {
                const { pref } = item.scope;
                const alpha2 = alpha3ToAlpha2(pref.scopeValue);
                // An unmappable stored code cannot be written; the row is not drawn.
                if (!alpha2 || !pref.scopeValue) return null;
                const country = { alpha2, alpha3: pref.scopeValue, label: pref.publicationName };
                return (
                    <PublicationControlRow
                        {...prefs.storedCountryRow(country)}
                        rawName={localizedCountryName(pref.scopeValue, appLanguage)}
                        flag={flagForAlpha2(alpha2)}
                        subtitle={`${t('publicationPrefs.scopeKindCountry')} · ${t('publicationPage.preferred')}`}
                        onPress={() =>
                            router.push({
                                pathname: '/logged-in/sources-publishers',
                                params: { countryCode: country.alpha3, countryName: localizedCountryName(country.alpha3, appLanguage) },
                            })
                        }
                        testID={`sources-scope-${item.scope.group.key}`}
                    />
                );
            }
            const { pub } = item;
            const tags = [pub.subscribed ? t('publicationPage.subscribed') : null, pub.kind && pub.kind !== 'deprioritize' ? t(TAG_KEY[pub.kind]) : null];
            return (
                <PublicationListRow
                    rawName={pub.displayName}
                    flag={pub.countryCode ? flagForAlpha2(alpha3ToAlpha2(pub.countryCode)) : null}
                    subtitle={tags.filter(Boolean).join(' · ')}
                    onPress={() =>
                        openPublicationPage({ publisherId: pub.publisherId, rawName: pub.displayName, countryCode: pub.countryCode })
                    }
                    testID={`sources-tagged-${pub.key}`}
                />
            );
        },
        [prefs, appLanguage, t],
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
                <View style={{ flex: 1 }}>
                <FlatList
                    data={items}
                    keyExtractor={(item) => (item.type === 'scope' ? item.scope.group.key : item.pub.key)}
                    renderItem={renderItem}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ paddingTop: SUBPAGE_TOP_GAP, paddingBottom: endClearance }}
                    showsVerticalScrollIndicator={false}
                    ListHeaderComponent={
                        <VStack>
                            <SourceSearch onActiveChange={setSearching} />
                            {items.length === 0 && !searching ? (
                                // The tutorial hero over the empty message (FinalMotion, Lottie moments).
                                <ForYouEmptyState
                                    testID="sources-empty"
                                    compact
                                    animationId="sources-where-it-lives"
                                    body={t('you.sources.empty')}
                                    action={{ label: t('nav.learnMore'), onPress: () => openTutorial('sources'), testID: 'sources-empty-learn' }}
                                />
                            ) : null}
                        </VStack>
                    }
                    ListFooterComponent={
                        items.length > 0 ? (
                            <Text size="xs" className="text-ink-2 px-4">
                                {t('you.sources.footnote')}
                            </Text>
                        ) : undefined
                    }
                />
                </View>
            )}
        </Box>
    );
};

export default PublicationPreferencesScreen;
