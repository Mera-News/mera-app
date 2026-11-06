// Saved's row: the "Read later" title with Group by and round Archive and
// Export icons, TRANSPARENT like the Library header (owner: no fill, no
// hairline). On Read later it sits under the page header and rides with it, so
// it never scrolls away and never hangs alone under the status bar; the list
// scrolls beneath it. The Archive icon always shows, or an empty Read later
// could not reach Archive; Group by and Export show only with rows.
//
// On the Archive page the header names the list, so the row is Group by and
// Export alone, in the list's own header.

import { GlassPlate } from '@/components/custom/GlassSurface';
import InlineChoiceChip from '@/components/custom/nav/InlineChoiceChip';
import PageTitleRow from '@/components/custom/nav/PageTitleRow';
import type { SavedList } from '@/lib/saved-state';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';
import type { SavedGroupBy } from './saved-groups';

/** The pinned row's height. The list pads by it so its first card starts below. */
export const SAVED_PINNED_HEIGHT = 56;

const GROUP_BYS: readonly SavedGroupBy[] = ['newest', 'facts', 'priority'];
const GROUP_ICON = { newest: 'schedule', facts: 'person-outline', priority: 'outlined-flag' } as const;
const groupIconOf = (g: SavedGroupBy) => GROUP_ICON[g];

const BUTTON = 38;
const BUTTON_FRAME = 44;

/** A childless labelled button over a hidden visual: a glyph inside a button
 *  surfaces on iOS as its own StaticText. */
const RoundIcon: React.FC<{
    readonly icon: keyof typeof MaterialIcons.glyphMap;
    readonly label: string;
    readonly onPress: () => void;
    readonly testID: string;
}> = ({ icon, label, onPress, testID }) => {
    const colors = useColors();
    const styles = useStyles();
    return (
        <View style={styles.frame}>
            <View
                style={styles.button}
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                <GlassPlate />
                <MaterialIcons name={icon} size={19} color={colors.ink} />
            </View>
            <Pressable
                testID={testID}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={label}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );
};

interface Props {
    readonly list: SavedList;
    readonly groupBy: SavedGroupBy;
    readonly onGroupByChange: (groupBy: SavedGroupBy) => void;
    /** The current list has articles. */
    readonly hasRows: boolean;
    /** The host header's measured height: the row sits directly under it. */
    readonly headerHeight: number;
    /** The host header's 0..1 collapse value; the row rides with it. */
    readonly hidden?: SharedValue<number>;
    readonly onOpenArchive: () => void;
    readonly onExport: () => void;
}

const SavedExportRow: React.FC<Props> = ({
    list,
    groupBy,
    onGroupByChange,
    hasRows,
    headerHeight,
    hidden,
    onOpenArchive,
    onExport,
}) => {
    const { t } = useTranslation();
    const styles = useStyles();

    const pinned = list === 'later';
    const ride = useAnimatedStyle(
        () => ({
            transform: [{ translateY: hidden ? -hidden.value * (headerHeight + SAVED_PINNED_HEIGHT) : 0 }],
        }),
        [hidden, headerHeight],
    );
    const groupLabel = (g: SavedGroupBy) =>
        g === 'facts'
            ? t('you.profile.facts')
            : g === 'priority'
              ? t('library.saved.groupPriority')
              : t('library.saved.groupNewest');

    const trailing = (
        <View style={styles.trailing}>
            {hasRows ? (
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
            ) : null}
            {pinned ? (
                <RoundIcon
                    icon="archive"
                    label={t('library.saved.openArchive')}
                    onPress={onOpenArchive}
                    testID="saved-archive-open"
                />
            ) : null}
            {hasRows ? (
                <RoundIcon
                    icon="ios-share"
                    label={t('savedExport.fabA11y')}
                    onPress={onExport}
                    testID="saved-export-open"
                />
            ) : null}
        </View>
    );

    if (!pinned) {
        return (
            <View testID="saved-export-row" style={styles.inline}>
                {trailing}
            </View>
        );
    }
    return (
        <Animated.View
            testID="saved-export-row"
            pointerEvents="box-none"
            style={[styles.pinned, { top: headerHeight }, ride]}
        >
            <PageTitleRow title={t('library.saved.readLater')} trailing={trailing} testID="saved-title-row" />
        </Animated.View>
    );
};

const useStyles = themedStyles((c) => StyleSheet.create({
    pinned: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: SAVED_PINNED_HEIGHT,
        paddingHorizontal: PAGE_SIDE_INSET,
        justifyContent: 'center',
        overflow: 'hidden',
        zIndex: 5,
    },
    inline: { flexDirection: 'row', justifyContent: 'flex-end', paddingBottom: 8 },
    trailing: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    frame: { width: BUTTON_FRAME, height: BUTTON_FRAME, alignItems: 'center', justifyContent: 'center' },
    button: {
        width: BUTTON,
        height: BUTTON,
        borderRadius: BUTTON / 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: c.trackBorder,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export default SavedExportRow;
