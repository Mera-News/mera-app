import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { alpha3ToAlpha2, flagForAlpha2 } from '@/components/custom/locations/location-display';
import PublicationListRow from '@/components/custom/publication-page/PublicationListRow';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import type { PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import { setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';
import logger from '@/lib/logger';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList } from 'react-native';
import PublicationPrefRow from './PublicationPrefRow';
import SourceSearch from './SourceSearch';
import { useAdjustedSources, type AdjustedSource, type TaggedPublication } from './use-adjusted-sources';

interface PublicationPreferencesScreenProps {
    readonly onBack: () => void;
}

type Item = { readonly type: 'publication'; readonly pub: TaggedPublication } | { readonly type: 'scope'; readonly scope: AdjustedSource };

const TAG_KEY: Record<PublicationPrefKind, 'you.sources.more' | 'you.sources.fewer' | 'you.sources.muted'> = {
    boost: 'you.sources.more',
    deprioritize: 'you.sources.fewer',
    mute: 'you.sources.muted',
};

/**
 * You > Settings > Sources: search ("Find a publication"), then ONE list of
 * every publication the reader has tagged (Subscribed, More, Fewer, Muted).
 * A row opens the publication page, where every tag is set. Country scopes
 * ("prefer sources from India") have no page, so they keep an in-place row at
 * the end; a scope converts its stored alpha-3 to alpha-2 exactly once, here,
 * before the shared writer, and can never be muted.
 */
const PublicationPreferencesScreen: React.FC<PublicationPreferencesScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const { publications, scopes, isLoading } = useAdjustedSources();
    const bottom = useTabBarClearance();
    const [searching, setSearching] = useState(false);
    // Keyed on `pref.id`, never the label: a scope "India" and a publication
    // called "India" must not lock each other.
    const [busyId, setBusyId] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);

    const items = useMemo<Item[]>(
        () => [
            ...publications.map((pub) => ({ type: 'publication' as const, pub })),
            ...scopes.map((scope) => ({ type: 'scope' as const, scope })),
        ],
        [publications, scopes],
    );

    /** A scope row's country target, or null when its stored code is unusable. */
    const countryTarget = (pref: PublicationPreferenceModel, method: string) => {
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

    const writeScope = useCallback(async (pref: PublicationPreferenceModel, kind: PublicationPrefKind | 'none', method: string) => {
        if (kind === 'mute') return; // a scope can never be muted; its row offers no Mute
        setBusyId(pref.id);
        try {
            const target = countryTarget(pref, method);
            if (target) await setSourcePrefFromUi(target, kind === 'none' ? 'none' : kind === 'boost' ? 'prioritised' : 'deprioritised');
            if (kind === 'none') setOpenId(null);
        } catch (error) {
            logger.captureException(error, {
                tags: { component: 'PublicationPreferencesScreen', method },
                extra: { prefId: pref.id, kind },
            });
        } finally {
            setBusyId(null);
        }
        // countryTarget is a plain helper with no state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSetKind = useCallback((pref: PublicationPreferenceModel, kind: PublicationPrefKind) => void writeScope(pref, kind, 'setKind'), [writeScope]);
    const handleClear = useCallback((pref: PublicationPreferenceModel) => void writeScope(pref, 'none', 'clear'), [writeScope]);
    const handleToggle = useCallback((pref: PublicationPreferenceModel) => {
        setOpenId((prev) => (prev === pref.id ? null : pref.id));
    }, []);

    const renderItem = useCallback(
        ({ item }: { item: Item }) => {
            if (item.type === 'scope') {
                const { pref } = item.scope;
                return (
                    <PublicationPrefRow
                        pref={pref}
                        busy={busyId === pref.id}
                        isOpen={openId === pref.id}
                        onToggle={handleToggle}
                        onSetKind={handleSetKind}
                        onClear={handleClear}
                    />
                );
            }
            const { pub } = item;
            const tags = [pub.subscribed ? t('publicationPage.subscribed') : null, pub.kind ? t(TAG_KEY[pub.kind]) : null];
            return (
                <PublicationListRow
                    rawName={pub.displayName}
                    flag={pub.countryCode ? flagForAlpha2(alpha3ToAlpha2(pub.countryCode)) : null}
                    subtitle={tags.filter(Boolean).join(' · ')}
                    // The tags line names the state; no second glyph.
                    prefLevel="none"
                    onPress={() =>
                        openPublicationPage({ publisherId: pub.publisherId, rawName: pub.displayName, countryCode: pub.countryCode })
                    }
                    testID={`sources-tagged-${pub.key}`}
                />
            );
        },
        [busyId, openId, handleToggle, handleSetKind, handleClear, t],
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
                    data={items}
                    keyExtractor={(item) => (item.type === 'scope' ? item.scope.group.key : item.pub.key)}
                    renderItem={renderItem}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ paddingTop: SUBPAGE_TOP_GAP, paddingBottom: bottom + 24 }}
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
                        ) : null
                    }
                />
            )}
        </Box>
    );
};

export default PublicationPreferencesScreen;
