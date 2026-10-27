import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useMeraCorner } from '@/components/custom/mera-button/corner';
import { topicLabel, topicSlug, visibleTopics } from '@/lib/explore/topic-filter';
import type { CanonicalTopic, CanonicalTopicFacet } from '@/lib/generated/graphql-types';
import { MERA_BUTTON_BAR_GAP, MERA_BUTTON_EDGE, MERA_BUTTON_SIZE, useTabBarClearance } from '@/lib/navigation/tab-bar';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View, useWindowDimensions } from 'react-native';

interface Props {
    readonly topics: readonly CanonicalTopic[];
    /** The active page's facets (unfiltered counts). */
    readonly facets: readonly CanonicalTopicFacet[];
    readonly pick: string | null;
    readonly onPick: (id: string | null) => void;
}

const PILL_HEIGHT = 44;
/** The kit sheet never caps its height: the rows scroll inside this share of the window,
 *  as the ••• menu's do, so the title and "All topics" stay on screen with 25 topics. */
const LIST_MAX_SHARE = 0.62;
/** Apply a pick this long after the tap if the sheet never reports it has gone (closeThen's fallback). */
const CLOSE_FALLBACK_MS = 1200;

/** The World topic filter: a pill above the Mera button and the sheet it opens. */
export default function WorldTopicPill({ topics, facets, pick, onPick }: Props) {
    const { t } = useTranslation();
    const c = useColors();
    const corner = useMeraCorner();
    const clearance = useTabBarClearance();
    const { height: windowHeight } = useWindowDimensions();
    const [open, setOpen] = useState(false);
    // Applied on the sheet's onClosed: a list remount under a leaving Modal is jank.
    const pending = useRef<{ id: string | null } | null>(null);
    const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (fallback.current) clearTimeout(fallback.current);
        },
        [],
    );

    const rows = visibleTopics(topics, facets);
    const total = facets.reduce((n, f) => n + f.count, 0);
    const picked = pick ? topics.find((tp) => tp.id === pick) : undefined;
    const pickedName = picked ? topicLabel(t, picked) : null;
    const base = clearance + MERA_BUTTON_BAR_GAP;
    const bottom = corner === 'br' ? base + MERA_BUTTON_SIZE + 12 : base;

    const onClosed = () => {
        if (fallback.current) clearTimeout(fallback.current);
        fallback.current = null;
        const p = pending.current;
        pending.current = null;
        if (p) onPick(p.id);
    };
    const choose = (id: string | null) => {
        pending.current = { id };
        setOpen(false);
        fallback.current = setTimeout(onClosed, CLOSE_FALLBACK_MS);
    };
    // Scrim, drag or back on an open sheet: close, pick nothing.
    const dismiss = () => {
        if (!open) return;
        pending.current = null;
        setOpen(false);
    };

    const fg = pickedName ? c.onAccent : c.ink;
    return (
        <>
            <View
                pointerEvents="box-none"
                style={{ position: 'absolute', right: MERA_BUTTON_EDGE, bottom, zIndex: 5 }}
            >
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        height: PILL_HEIGHT,
                        borderRadius: PILL_HEIGHT / 2,
                        borderWidth: 1,
                        borderColor: pickedName ? c.accent : c.line,
                        backgroundColor: pickedName ? c.accent : c.chrome,
                        maxWidth: 240,
                    }}
                >
                    <Pressable
                        testID="world-topic-pill"
                        onPress={() => setOpen(true)}
                        accessibilityRole="button"
                        accessibilityLabel={t('explore.topicFilter.pillA11y', {
                            topic: pickedName ?? t('explore.topicFilter.all'),
                        })}
                        style={{ flexShrink: 1, minHeight: PILL_HEIGHT, justifyContent: 'center' }}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 14, paddingRight: pickedName ? 4 : 14 }}>
                            <MaterialIcons name={pickedName ? 'label' : 'filter-list'} size={18} color={fg} />
                            <Text size="sm" numberOfLines={1} style={{ color: fg, flexShrink: 1, fontWeight: '600' }}>
                                {pickedName ?? t('explore.topicFilter.pill')}
                            </Text>
                        </View>
                    </Pressable>
                    {pickedName ? (
                        <Pressable
                            testID="world-topic-clear"
                            onPress={() => onPick(null)}
                            accessibilityRole="button"
                            accessibilityLabel={t('explore.topicFilter.clearA11y')}
                            style={{ width: PILL_HEIGHT, height: PILL_HEIGHT, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <MaterialIcons name="close" size={18} color={fg} />
                        </Pressable>
                    ) : null}
                </View>
            </View>
            <BottomSheet testID="world-topic-sheet" open={open} onClose={dismiss} onClosed={onClosed}>
                <Text style={{ color: c.ink, fontSize: 17, fontWeight: '600', lineHeight: 24, paddingVertical: 8 }}>
                    {t('explore.topicFilter.sheetTitle')}
                </Text>
                <ScrollView testID="world-topic-list" style={{ maxHeight: windowHeight * LIST_MAX_SHARE }} bounces={false}>
                    <Row testID="world-topic-row-all" label={t('explore.topicFilter.all')} count={total} selected={!pick} onPress={() => choose(null)} />
                    {rows.map(({ topic, count }) => (
                        <Row
                            key={topic.id}
                            testID={`world-topic-row-${topicSlug(topic.path)}`}
                            label={topicLabel(t, topic)}
                            count={count}
                            selected={topic.id === pick}
                            onPress={() => choose(topic.id)}
                        />
                    ))}
                </ScrollView>
            </BottomSheet>
        </>
    );
}

function Row({ label, count, selected, onPress, testID }: { label: string; count: number; selected: boolean; onPress: () => void; testID: string }) {
    const c = useColors();
    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={`${label}, ${count}`}
            style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 8 }}
        >
            {/* fontSize with its lineHeight: Text keeps its token's smaller lineHeight otherwise and clips. */}
            <Text style={{ flex: 1, color: c.ink, fontSize: 16, lineHeight: 22 }}>{label}</Text>
            <Text style={{ color: c.ink3, fontSize: 14, lineHeight: 20 }}>{count}</Text>
            {selected ? <MaterialIcons name="check" size={20} color={c.accent} /> : null}
        </Pressable>
    );
}
