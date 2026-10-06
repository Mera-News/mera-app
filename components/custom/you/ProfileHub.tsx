import BlockedBanner from '@/components/custom/BlockedBanner';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { sentenceCase } from '@/components/custom/facts/sentence-case';
import { composeLocationLabel, roleMeta } from '@/components/custom/locations/location-display';
import HowThisPageWorks from '@/components/custom/nav/HowThisPageWorks';
import type { PageHeaderBinding } from '@/components/custom/nav/types';
import { useNotInterestedData } from '@/components/custom/not-interested/use-not-interested-data';
import { actionDisplay, isRevertible } from '@/components/custom/persona-audit/action-display';
import SourceKindChip from '@/components/custom/publication-preferences/SourceKindChip';
import { useAdjustedSources } from '@/components/custom/publication-preferences/use-adjusted-sources';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { authClient } from '@/lib/auth-client';
import { HARD_SUPPRESSION_STRENGTH } from '@/lib/database/services/suppression-service';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { DisplayPublicationName } from '@/lib/stores/publication-display-store';
import { useUserStore } from '@/lib/stores/user-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { runOnUI, scrollTo, useAnimatedRef } from 'react-native-reanimated';
import FocusTarget, { FocusHostProvider, type FocusHost } from './FocusTarget';
import HubCard, { ForwardChevron, HUB_ACCENT, HUB_ACCENT_SOFT, HubEmpty, HubRow, HubValue } from './HubCard';
import {
    useActiveTopicTexts,
    useHubActivity,
    useHubCleanup,
    useHubFacts,
    useHubPlaces,
    useHubSubscriptions,
    type CountState,
} from './use-hub-data';

/** Screens pushed inside the You stack (L1's thin routes). */
type YouScreen = 'facts' | 'locations' | 'sources' | 'hygiene-review' | 'not-interested' | 'activity';
const openYou = (screen: YouScreen) => router.push(`/logged-in/app_container/you/${screen}` as Href);

const CARD_GAP = 8;
const SHOWN = { facts: 3, places: 2, sources: 2, declined: 2, payFor: 2, activity: 2 } as const;

const FactRow: React.FC<{ readonly fact: Fact; readonly counts: Map<string, number>; readonly countState: CountState }> = ({
    fact,
    counts,
    countState,
}) => {
    const { t } = useTranslation();
    const texts = useActiveTopicTexts(fact.id);
    const total = texts.reduce((sum, text) => sum + (counts.get(text) ?? 0), 0);
    const value =
        countState === 'counting'
            ? t('configPanel.articleCountPending')
            : countState === 'unavailable'
                ? null
                : total > 0
                    ? t('configPanel.articleCount', { count: total })
                    : t('configPanel.articleCountNone');
    return (
        <HubRow testID={`profile-fact-${fact.id}`} trailing={value ? <HubValue>{value}</HubValue> : null}>
            <TranslatableDynamic text={sentenceCase(fact.statement)} size="md" className="text-white" numberOfLines={2} />
        </HubRow>
    );
};

const RoleChip: React.FC<{ readonly role: Parameters<typeof roleMeta>[0] }> = ({ role }) => {
    const { t } = useTranslation();
    const meta = roleMeta(role);
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                height: 24,
                paddingHorizontal: 9,
                borderRadius: 999,
                backgroundColor: 'rgba(231,138,83,0.12)',
                borderWidth: 1,
                borderColor: 'rgba(231,138,83,0.35)',
            }}
        >
            <MaterialIcons name={meta.icon} size={13} color={HUB_ACCENT_SOFT} />
            <Text scaleTier="chrome" style={{ color: HUB_ACCENT_SOFT, fontSize: 12, fontWeight: '600' }}>
                {t(`locations.roles.${meta.labelKey}`)}
            </Text>
        </View>
    );
};

/** An inline link inside a card row ("Add a city", "Review"). */
const RowLink: React.FC<{ readonly label: string; readonly onPress: () => void; readonly testID: string }> = ({
    label,
    onPress,
    testID,
}) => (
    <Pressable
        testID={testID}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center' }}
    >
        <Text style={{ color: HUB_ACCENT, fontSize: 14 }}>{label}</Text>
        <ForwardChevron size={16} />
    </Pressable>
);

interface ProfileHubProps {
    readonly header: PageHeaderBinding;
}

/**
 * You > Profile: everything Mera uses to pick your news, a few of each with
 * View all. Replaces the old Profile screen and the Advanced hub.
 *
 * Facts, Places, Sources and Topics you turned down always render: they are
 * where the Feed and Interests quick-settings jump lands. Cleanup, pay-for and
 * Activity render only when they have rows.
 *
 * No name, monogram or greeting (Mera never knows the name). No chat invite:
 * the Mera button carries "Tell me about something new...".
 */
const ProfileHub: React.FC<ProfileHubProps> = ({ header }) => {
    const { t } = useTranslation();
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

    const { facts, counts, countState } = useHubFacts();
    const places = useHubPlaces();
    const { rows: sources } = useAdjustedSources();
    const cleanup = useHubCleanup();
    const { filters, topics } = useNotInterestedData();
    const subscriptions = useHubSubscriptions();
    const activity = useHubActivity(SHOWN.activity);

    // Hidden (hard filters) first, then soft filters and turned-down topics.
    const declined = useMemo(
        () => [
            ...filters.map((f) => ({
                id: f.id,
                text: f.value ?? f.pattern,
                hard: f.strength >= HARD_SUPPRESSION_STRENGTH,
            })),
            ...topics.map((topic) => ({ id: topic.id, text: topic.text, hard: false })),
        ],
        [filters, topics],
    );

    const scrollRef = useAnimatedRef<Animated.ScrollView>();
    const contentRef = useRef<View>(null);
    const scrollToY = useCallback(
        (y: number, animated: boolean) => {
            runOnUI((yy: number, a: boolean) => {
                'worklet';
                scrollTo(scrollRef, 0, yy, a);
            })(y, animated);
        },
        [scrollRef],
    );
    const focusHost = useMemo<FocusHost>(() => ({ contentRef, scrollToY }), [scrollToY]);

    const viewAll = (count: number, screen: YouScreen) => ({
        label: count > 0 ? t('you.profile.viewAll', { count }) : t('you.profile.viewAllNoCount'),
        onPress: () => openYou(screen),
    });

    return (
        <FocusHostProvider host={focusHost}>
            <Animated.ScrollView
                ref={scrollRef}
                testID="profile-hub"
                onScroll={header.scrollHandler}
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingTop: header.headerHeight + 14, paddingHorizontal: 14, paddingBottom: endClearance }}
            >
                <View ref={contentRef} collapsable={false} style={{ gap: CARD_GAP }}>
                    {userPersona?.blockedByLlm ? <BlockedBanner reason={userPersona.blockedByLlmReason} /> : null}

                    <FocusTarget id="profile.facts" announce={t('you.profile.facts')}>
                        <HubCard
                            testID="profile-card-facts"
                            title={t('you.profile.facts')}
                            hint={{ title: t('you.hints.facts.title'), paragraphs: [t('you.hints.facts.body')] }}
                            viewAll={facts && facts.length > 0 ? viewAll(facts.length, 'facts') : undefined}
                        >
                            {facts && facts.length === 0 ? <HubEmpty testID="profile-facts-empty">{t('you.profile.factsEmpty')}</HubEmpty> : null}
                            {(facts ?? []).slice(0, SHOWN.facts).map((fact) => (
                                <FactRow key={fact.id} fact={fact} counts={counts} countState={countState} />
                            ))}
                        </HubCard>
                    </FocusTarget>

                    <FocusTarget id="profile.places" announce={t('you.profile.places')}>
                        <HubCard
                            testID="profile-card-places"
                            title={t('you.profile.places')}
                            hint={{
                                title: t('you.hints.places.title'),
                                paragraphs: [t('you.hints.places.body'), t('you.hints.places.body2')],
                            }}
                            viewAll={places && places.length > 0 ? viewAll(places.length, 'locations') : undefined}
                        >
                            {places && places.length === 0 ? (
                                <HubRow trailing={<RowLink testID="profile-places-add" label={t('you.profile.addCity')} onPress={() => openYou('locations')} />}>
                                    <Text style={{ color: '#D4D4D4', fontSize: 14 }}>{t('you.profile.placesEmpty')}</Text>
                                </HubRow>
                            ) : null}
                            {(places ?? []).slice(0, SHOWN.places).map((loc) => (
                                <HubRow key={loc.id} testID={`profile-place-${loc.id}`} trailing={<RoleChip role={loc.role} />}>
                                    <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 15 }}>{composeLocationLabel(loc)}</Text>
                                </HubRow>
                            ))}
                        </HubCard>
                    </FocusTarget>

                    <FocusTarget id="profile.sources" announce={t('you.profile.sources')}>
                        {/* View all always shows: Sources is also where you search
                            for a publication to adjust, so an empty card still
                            needs the way in. */}
                        <HubCard
                            testID="profile-card-sources"
                            title={t('you.profile.sources')}
                            hint={{ title: t('you.hints.sources.title'), paragraphs: [t('you.hints.sources.body')] }}
                            viewAll={viewAll(sources.length, 'sources')}
                        >
                            {sources.length === 0 ? <HubEmpty>{t('you.profile.sourcesEmpty')}</HubEmpty> : null}
                            {sources.slice(0, SHOWN.sources).map(({ group, pref, kind }) => (
                                <HubRow key={group.key} trailing={kind ? <SourceKindChip kind={kind} /> : null}>
                                    <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 15 }}>
                                        {pref.scopeKind != null ? pref.publicationName : <DisplayPublicationName name={pref.publicationName} />}
                                    </Text>
                                </HubRow>
                            ))}
                        </HubCard>
                    </FocusTarget>

                    {cleanup.count > 0 ? (
                        <HubCard
                            testID="profile-card-cleanup"
                            title={t('you.profile.cleanup')}
                            badgeCount={cleanup.count}
                            hint={{ title: t('you.hints.cleanup.title'), paragraphs: [t('you.hints.cleanup.body')] }}
                        >
                            <HubRow trailing={<RowLink testID="profile-cleanup-review" label={t('you.profile.review')} onPress={() => openYou('hygiene-review')} />}>
                                {cleanup.firstSummary ? (
                                    <TranslatableDynamic text={cleanup.firstSummary} size="sm" className="text-gray-300" numberOfLines={2} />
                                ) : null}
                            </HubRow>
                        </HubCard>
                    ) : null}

                    <FocusTarget id="profile.topicsDeclined" announce={t('you.profile.topicsDeclined')}>
                        {/* View all always shows: Not interested is also where a
                            phrase is added by hand. */}
                        <HubCard
                            testID="profile-card-declined"
                            title={t('you.profile.topicsDeclined')}
                            hint={{ title: t('you.hints.topicsDeclined.title'), paragraphs: [t('you.hints.topicsDeclined.body')] }}
                            viewAll={viewAll(declined.length, 'not-interested')}
                        >
                            {declined.length === 0 ? <HubEmpty>{t('you.profile.topicsDeclinedEmpty')}</HubEmpty> : null}
                            {declined.slice(0, SHOWN.declined).map((row) => (
                                <HubRow key={row.id} trailing={<HubValue>{row.hard ? t('you.profile.hidden') : t('you.profile.less')}</HubValue>}>
                                    <TranslatableDynamic text={sentenceCase(row.text)} size="md" className="text-white" numberOfLines={1} />
                                </HubRow>
                            ))}
                        </HubCard>
                    </FocusTarget>

                    {subscriptions.length > 0 ? (
                        <HubCard
                            testID="profile-card-pay-for"
                            title={t('you.profile.payFor')}
                            hint={{ title: t('you.hints.payFor.title'), paragraphs: [t('you.hints.payFor.body')] }}
                            viewAll={viewAll(subscriptions.length, 'sources')}
                        >
                            {subscriptions.slice(0, SHOWN.payFor).map((sub) => (
                                <HubRow key={sub.id} trailing={<HubValue>{t('you.profile.subscribed')}</HubValue>}>
                                    <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 15 }}>{sub.publisherName}</Text>
                                </HubRow>
                            ))}
                        </HubCard>
                    ) : null}

                    {activity.length > 0 ? (
                        <HubCard
                            testID="profile-card-activity"
                            title={t('you.profile.activity')}
                            hint={{ title: t('you.hints.activity.title'), paragraphs: [t('you.hints.activity.body')] }}
                            viewAll={{ label: t('you.profile.viewAllNoCount'), onPress: () => openYou('activity') }}
                        >
                            {activity.map((row) => (
                                // Undo happens in the activity log, behind its
                                // confirm; the card only says it can be undone.
                                <HubRow
                                    key={row.id}
                                    trailing={!row.reverted && isRevertible(row.actionType) ? <HubValue>{t('articleMenu.undo')}</HubValue> : null}
                                >
                                    <TranslatableDynamic
                                        text={row.summary || t(`personaAudit.actionLabels.${actionDisplay(row.actionType).labelKey}` as never)}
                                        size="sm"
                                        className="text-gray-300"
                                        numberOfLines={2}
                                    />
                                </HubRow>
                            ))}
                        </HubCard>
                    ) : null}

                    <HowThisPageWorks pageId="profile" />
                </View>
            </Animated.ScrollView>
        </FocusHostProvider>
    );
};

export default ProfileHub;
