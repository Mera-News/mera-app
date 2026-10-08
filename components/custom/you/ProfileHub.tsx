import BlockedBanner from '@/components/custom/BlockedBanner';
import { openFactPage } from '@/components/custom/facts/open-fact-page';
import { sentenceCase } from '@/components/custom/facts/sentence-case';
import { composeLocationLabel, roleMeta } from '@/components/custom/locations/location-display';
import type { PageHeaderBinding } from '@/components/custom/nav/types';
import { useAdjustedSources } from '@/components/custom/publication-preferences/use-adjusted-sources';
import { Text } from '@/components/ui/text';
import { authClient } from '@/lib/auth-client';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { useUserStore } from '@/lib/stores/user-store';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { router, type Href } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Animated from 'react-native-reanimated';
import { Badge, Group, Help, Row, ViewAll } from './rows';
import { useActiveTopicTexts, useHubCleanup, useHubFacts, useHubPlaces } from './use-hub-data';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';
import { usePageScrollTarget } from '@/components/custom/nav/page-scroll';

/** Screens pushed inside the You stack. */
type YouScreen = 'facts' | 'locations' | 'sources' | 'hygiene-review' | 'activity';
const openYou = (screen: YouScreen) => router.push(`/logged-in/app_container/you/${screen}` as Href);

const SHOWN = 2;

const FactRow: React.FC<{ readonly fact: Fact }> = ({ fact }) => {
    const { t } = useTranslation();
    const count = useActiveTopicTexts(fact.id).length;
    return (
        <Row
            testID={`profile-fact-${fact.id}`}
            title={sentenceCase(fact.statement)}
            translatable
            value={t('you.profile.topicCount', { count })}
            onPress={() => openFactPage(fact)}
            hideChevron
        />
    );
};

interface ProfileHubProps {
    readonly header: PageHeaderBinding;
    /** The visible page of the focused tab: only it feeds the translation scheduler. */
    readonly active: boolean;
}

/**
 * You > Profile: what Mera knows about you, a few of each with View all.
 * Facts and Places always render (their empty lines say how they fill);
 * Tidy up only while Mera has a suggestion.
 *
 * No name, monogram or greeting (Mera never knows the name). No chat invite:
 * the Mera button carries "Tell me about something new...".
 */
const ProfileHub: React.FC<ProfileHubProps> = ({ header, active }) => {
    const { t } = useTranslation();
    // The tab's re-tap scrolls this page to the top (nav/page-scroll).
    const listRef = useRef<Animated.ScrollView>(null);
    usePageScrollTarget(listRef);
    const colors = useColors();
    const endClearance = useListEndClearance();

    // LOCAL identity first, the session only as a fallback (invariant 4): the
    // blocked banner must not vanish on a network wobble.
    const { data: session } = authClient.useSession();
    const localUserId = useUserStore((s) => s.userId);
    const userId = localUserId ?? session?.user?.id;
    const userPersona = useUserStore((s) => s.userPersona);
    const fetchUserPersona = useUserStore((s) => s.fetchUserPersona);
    useEffect(() => {
        if (!userPersona && userId) fetchUserPersona(userId).catch(() => { /* offline */ });
    }, [userId, userPersona, fetchUserPersona]);

    const facts = useHubFacts();
    const places = useHubPlaces();
    const { publications, scopes } = useAdjustedSources();
    const sourceCount = publications.length + scopes.length;
    const cleanup = useHubCleanup();

    return (
        <Animated.ScrollView
            ref={listRef}
            testID="profile-hub"
            // The header's handler sends a tick per scroll; rows that land
            // with no scroll (data arriving) need one too, or they stay in
            // English (TranslatableDynamic measures on ticks).
            onScroll={header.scrollHandler}
            onContentSizeChange={() => {
                if (active) notifyScrollTick();
            }}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingTop: header.headerHeight + PAGE_CONTENT_GAP, paddingHorizontal: PAGE_SIDE_INSET, paddingBottom: endClearance, gap: 10 }}
        >
            <Help>{t('you.profile.subtitle')}</Help>
            {userPersona?.blockedByLlm ? <BlockedBanner reason={userPersona.blockedByLlmReason} /> : null}

            <Group testID="profile-card-facts">
                <Row title={t('you.profile.facts')} bold value={facts && facts.length > 0 ? String(facts.length) : undefined} />
                {facts && facts.length === 0 ? (
                    <Row testID="profile-facts-empty" title={t('you.profile.factsEmpty')} titleColor={colors.ink2} />
                ) : null}
                {(facts ?? []).slice(0, SHOWN).map((fact) => <FactRow key={fact.id} fact={fact} />)}
                {facts && facts.length > 0 ? (
                    <ViewAll
                        testID="profile-facts-view-all"
                        label={t('you.profile.viewAll', { count: facts.length })}
                        onPress={() => openYou('facts')}
                    />
                ) : null}
            </Group>

            <Group testID="profile-card-places">
                <Row title={t('you.profile.places')} bold value={places && places.length > 0 ? String(places.length) : undefined} />
                {places && places.length === 0 ? (
                    <Row
                        testID="profile-places-add"
                        title={t('you.profile.placesEmpty')}
                        titleColor={colors.ink2}
                        trailing={
                            <Text style={{ color: colors.accentText, fontSize: 14, fontWeight: '600' }}>{t('you.profile.addCity')}</Text>
                        }
                        onPress={() => openYou('locations')}
                    />
                ) : null}
                {(places ?? []).slice(0, SHOWN).map((loc) => {
                    const meta = roleMeta(loc.role);
                    return (
                        <Row
                            key={loc.id}
                            testID={`profile-place-${loc.id}`}
                            title={composeLocationLabel(loc)}
                            titleLines={1}
                            trailing={<Badge icon={meta.icon} label={t(`locations.roles.${meta.labelKey}`)} />}
                            onPress={() => openYou('locations')}
                            hideChevron
                        />
                    );
                })}
                {places && places.length > SHOWN ? (
                    <ViewAll
                        testID="profile-places-view-all"
                        label={t('you.profile.viewAll', { count: places.length })}
                        onPress={() => openYou('locations')}
                    />
                ) : null}
            </Group>

            <Group testID="profile-card-lists">
                {cleanup.count > 0 ? (
                    <Row
                        testID="profile-row-tidy-up"
                        title={t('you.profile.tidyUp')}
                        trailing={<Badge label={String(cleanup.count)} />}
                        onPress={() => openYou('hygiene-review')}
                    />
                ) : null}
                <Row
                    testID="profile-row-sources"
                    title={t('you.profile.sources')}
                    value={sourceCount > 0 ? t('you.profile.adjusted', { count: sourceCount }) : undefined}
                    subtitle={sourceCount > 0 ? undefined : t('you.profile.sourcesEmpty')}
                    onPress={() => openYou('sources')}
                />
                <Row testID="profile-row-changes" title={t('you.profile.changes')} onPress={() => openYou('activity')} />
            </Group>
        </Animated.ScrollView>
    );
};

export default ProfileHub;
