// Saved's pinned block: the Read later / Archive switch, then the count with
// Group by and the glass Export button, TRANSPARENT like the Library header
// (owner: no fill, no hairline). It sits under the page header and rides with
// it, so it never scrolls away and never hangs alone under the status bar; the
// list scrolls beneath it. The switch always shows, or an empty Read later would
// hide Archive. The row under it shows only while the list has articles.
//
// The count is the shell's PageTitleRow; Saved's ? is in the tab header.

import { GlassPlate } from '@/components/custom/GlassSurface';
import InlineChoiceChip from '@/components/custom/nav/InlineChoiceChip';
import PageTitleRow from '@/components/custom/nav/PageTitleRow';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import type { SavedList } from '@/lib/saved-state';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';
import type { SavedGroupBy } from './saved-groups';

/** The switch's 44pt track and the gap under it. */
const SWITCH_HEIGHT = 52;
const COUNT_ROW_HEIGHT = 56;
/** The block's height. The list pads by it so its first card starts below. */
export const savedPinnedHeight = (hasRows: boolean): number => SWITCH_HEIGHT + (hasRows ? COUNT_ROW_HEIGHT : 0);

const LISTS: readonly SavedList[] = ['later', 'archive'];
const GROUP_BYS: readonly SavedGroupBy[] = ['newest', 'facts', 'priority'];
const GROUP_ICON = { newest: 'schedule', facts: 'person-outline', priority: 'outlined-flag' } as const;
const groupIconOf = (g: SavedGroupBy) => GROUP_ICON[g];

const BUTTON_H = 38;
const BUTTON_FRAME = 44;

interface Props {
    readonly list: SavedList;
    readonly onListChange: (list: SavedList) => void;
    readonly groupBy: SavedGroupBy;
    readonly onGroupByChange: (groupBy: SavedGroupBy) => void;
    /** Articles in the current list. */
    readonly count: number;
    /** The host header's measured height: the row sits directly under it. */
    readonly headerHeight: number;
    /** The host header's 0..1 collapse value; the row rides with it. */
    readonly hidden?: SharedValue<number>;
    readonly onExport: () => void;
}

const SavedExportRow: React.FC<Props> = ({
    list,
    onListChange,
    groupBy,
    onGroupByChange,
    count,
    headerHeight,
    hidden,
    onExport,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const styles = useStyles();

    const hasRows = count > 0;
    const height = savedPinnedHeight(hasRows);
    const ride = useAnimatedStyle(
        () => ({
            transform: [{ translateY: hidden ? -hidden.value * (headerHeight + height) : 0 }],
        }),
        [hidden, headerHeight, height],
    );
    const groupLabel = (g: SavedGroupBy) =>
        g === 'facts'
            ? t('you.profile.facts')
            : g === 'priority'
              ? t('library.saved.groupPriority')
              : t('library.saved.groupNewest');

    const exportButton = (
            // A childless labelled button over a hidden visual: a glyph inside a
            // button surfaces on iOS as its own StaticText.
            <View testID="saved-export-open-frame" style={styles.frame}>
                <View
                    style={styles.button}
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                >
                    <GlassPlate />
                    <MaterialIcons name="ios-share" size={17} color={colors.ink} />
                    <Text style={styles.label}>{t('library.saved.export')}</Text>
                </View>
                <Pressable
                    testID="saved-export-open"
                    onPress={onExport}
                    accessibilityRole="button"
                    accessibilityLabel={t('savedExport.fabA11y')}
                    style={StyleSheet.absoluteFill}
                />
            </View>
    );

    return (
        <Animated.View
            testID="saved-export-row"
            pointerEvents="box-none"
            style={[styles.block, { top: headerHeight, height }, ride]}
        >
            <SegmentedControl
                options={[
                    { value: LISTS[0], label: t('library.saved.readLater') },
                    { value: LISTS[1], label: t('library.saved.archive') },
                ]}
                value={list}
                onChange={onListChange}
                accessibilityLabel={t('nav.page.saved')}
                stretch
                testID="saved-list"
            />
            {hasRows ? (
                <View style={styles.countRow}>
                    <PageTitleRow
                        title={
                            list === 'archive'
                                ? t('library.saved.countArchive', { count })
                                : t('library.saved.countLater', { count })
                        }
                        trailing={
                            <View style={styles.trailing}>
                                <InlineChoiceChip
                                    options={GROUP_BYS}
                                    value={groupBy}
                                    labelOf={groupLabel}
                                    a11yLabelOf={(g) => t('library.saved.groupA11y', { group: groupLabel(g) })}
                                    onChange={onGroupByChange}
                                    iconOf={groupIconOf}
                                    menuTitle={t('library.saved.groupTitle')}
                                    rowRole="radio"
                                    testID="saved-group-chip"
                                />
                                {exportButton}
                            </View>
                        }
                        testID="saved-title-row"
                    />
                </View>
            ) : null}
        </Animated.View>
    );
};

const useStyles = themedStyles((c) => StyleSheet.create({
    block: {
        position: 'absolute',
        left: 0,
        right: 0,
        paddingHorizontal: PAGE_SIDE_INSET,
        overflow: 'hidden',
        zIndex: 5,
    },
    countRow: { position: 'absolute', left: PAGE_SIDE_INSET, right: PAGE_SIDE_INSET, top: SWITCH_HEIGHT, height: COUNT_ROW_HEIGHT, justifyContent: 'center' },
    trailing: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    frame: { minHeight: BUTTON_FRAME, justifyContent: 'center' },
    button: {
        height: BUTTON_H,
        paddingHorizontal: 14,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.trackBorder,
        overflow: 'hidden',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    label: { fontSize: 14, lineHeight: 18, fontWeight: '600', color: c.ink },
}));

export default SavedExportRow;
