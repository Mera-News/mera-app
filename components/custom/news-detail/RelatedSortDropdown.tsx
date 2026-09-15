import { CheckIcon, ChevronDownIcon, Icon } from '@/components/ui/icon';
import { Menu, MenuItem, MenuItemLabel } from '@/components/ui/menu';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { RelatedSortMode } from '@/lib/feed-grouping/related-articles-sort';
import { RELATED_SORT_MODES } from '@/lib/stores/related-sort-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

// User-facing labels. Deliberately NOT the internal mode names: "relevance"
// describes the algorithm (country blocks, then the reader's language and
// preferred publications), not what the reader gets, and "oldest"/"newest" on
// their own don't say oldest/newest WHAT.
const LABEL_KEYS: Record<RelatedSortMode, string> = {
    relevance: 'relatedSort.relevance',
    oldest: 'relatedSort.oldest',
    newest: 'relatedSort.newest',
};

interface RelatedSortDropdownProps {
    readonly value: RelatedSortMode;
    readonly onChange: (mode: RelatedSortMode) => void;
    /** e.g. 'related-sort' → trigger `related-sort-trigger`, options
     *  `related-sort-{relevance|oldest|newest}`. */
    readonly testIDPrefix: string;
}

/**
 * Sort control for the Related Articles list on both detail routes.
 *
 * Same anchored-menu construction as `ImportanceFilterDropdown` (gluestack
 * `Menu`, selection on each item's own `onPress` because the aria selection
 * layer never fires on native here) — but a separate component rather than a
 * generalisation of it: that one is typed to `ImportanceThreshold`, carries a
 * `filter-list` glyph and a "+" suffix meaning "this band and above", and none
 * of that is true of a sort. The shared part is ~15 lines of chrome; a common
 * abstraction would cost more than it removes.
 */
const RelatedSortDropdown: React.FC<RelatedSortDropdownProps> = ({
    value,
    onChange,
    testIDPrefix,
}) => {
    const { t } = useTranslation();

    return (
        <Menu
            placement="bottom right"
            offset={6}
            closeOnSelect
            trigger={(triggerProps) => (
                <Pressable
                    {...triggerProps}
                    accessibilityRole="button"
                    accessibilityLabel={t('relatedSort.a11yLabel')}
                    accessibilityValue={{ text: t(LABEL_KEYS[value] as any) }}
                    testID={`${testIDPrefix}-trigger`}
                    className="flex-row items-center rounded-full border border-primary-500 min-h-9 px-3"
                >
                    {/* The sort glyph is what distinguishes this chip from the
                        importance FILTER chip elsewhere in the app — the two
                        look alike otherwise and mean different things. */}
                    <MaterialIcons
                        name="swap-vert"
                        size={16}
                        color={ACCENT}
                        style={{ marginRight: 4 }}
                    />
                    <Text size="sm" numberOfLines={1} className="text-primary-500 font-semibold">
                        {t(LABEL_KEYS[value] as any)}
                    </Text>
                    <Icon as={ChevronDownIcon} size="xs" className="ml-1 text-primary-400" />
                </Pressable>
            )}
        >
            {RELATED_SORT_MODES.map((mode) => {
                const selected = mode === value;
                return (
                    <MenuItem
                        key={mode}
                        textValue={t(LABEL_KEYS[mode] as any)}
                        testID={`${testIDPrefix}-${mode}`}
                        onPress={() => onChange(mode)}
                        className="min-w-36 p-2.5"
                    >
                        <MenuItemLabel
                            size="sm"
                            className={selected ? 'text-primary-400 font-semibold' : ''}
                        >
                            {t(LABEL_KEYS[mode] as any)}
                        </MenuItemLabel>
                        {/* Fixed-width slot so labels align checked or not */}
                        <View style={{ width: 24, alignItems: 'flex-end' }}>
                            {selected && (
                                <Icon as={CheckIcon} size="sm" className="text-primary-400" />
                            )}
                        </View>
                    </MenuItem>
                );
            })}
        </Menu>
    );
};

export default RelatedSortDropdown;
