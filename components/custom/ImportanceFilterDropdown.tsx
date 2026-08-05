import { CheckIcon, ChevronDownIcon, Icon } from '@/components/ui/icon';
import { Menu, MenuItem, MenuItemLabel } from '@/components/ui/menu';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import {
    IMPORTANCE_THRESHOLDS,
    type ImportanceThreshold,
} from '@/lib/feed-ordering/importance-filter';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

// Same label keys as RelevanceChip, for the same reason: the control and the
// worded chip on each card must never disagree.
const LABEL_KEYS: Record<ImportanceThreshold, string> = {
    high: 'relevance.high',
    medium: 'relevance.medium',
    low: 'relevance.low',
};

interface ImportanceFilterDropdownProps {
    readonly value: ImportanceThreshold;
    readonly onChange: (threshold: ImportanceThreshold) => void;
    /** e.g. 'feed-importance' → trigger `feed-importance-trigger`, options
     *  `feed-importance-{high|medium|low}`. */
    readonly testIDPrefix: string;
}

/**
 * The importance-threshold control: a rounded chip (`Med ⌄`) that opens a
 * FLOATING menu anchored to it — gluestack Menu, not Select, by explicit user
 * choice: Select's native presentation is a bottom actionsheet, and the wanted
 * look is the web-style anchored dropdown. The chip itself keeps the Select
 * rounded-md trigger dimensions. Used by both the Feed and Dashboard headers.
 */
const ImportanceFilterDropdown: React.FC<ImportanceFilterDropdownProps> = ({
    value,
    onChange,
    testIDPrefix,
}) => {
    const { t } = useTranslation();

    return (
        <Menu
            placement="bottom left"
            offset={6}
            closeOnSelect
            // Selection rides on each MenuItem's own `onPress` (composed into
            // the item Pressable by the creator), NOT the aria selection layer:
            // both selectionMode/onSelectionChange and onAction never fired on
            // native here (sim-verified) — only the plain Pressable press does.
            trigger={(triggerProps) => (
                <Pressable
                    {...triggerProps}
                    accessibilityRole="button"
                    accessibilityLabel={t('importanceFilter.a11yLabel')}
                    accessibilityValue={{ text: t(LABEL_KEYS[value] as any) }}
                    testID={`${testIDPrefix}-trigger`}
                    // The Select rounded/md trigger's dimensions, hand-carried:
                    // min-h-10, rounded-full, px-4, text-base.
                    className="flex-row items-center rounded-full border border-primary-500 min-h-10 px-4"
                >
                    <Text size="md" numberOfLines={1} className="text-primary-500 font-semibold">
                        {t(LABEL_KEYS[value] as any)}
                    </Text>
                    <Icon as={ChevronDownIcon} size="sm" className="ml-1.5 text-primary-400" />
                </Pressable>
            )}
        >
            {IMPORTANCE_THRESHOLDS.map((threshold) => {
                const selected = threshold === value;
                return (
                    <MenuItem
                        key={threshold}
                        textValue={t(LABEL_KEYS[threshold] as any)}
                        testID={`${testIDPrefix}-${threshold}`}
                        onPress={() => onChange(threshold)}
                    >
                        <MenuItemLabel
                            size="sm"
                            className={selected ? 'text-primary-400 font-semibold' : ''}
                        >
                            {t(LABEL_KEYS[threshold] as any)}
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

export default ImportanceFilterDropdown;
