import { CheckIcon, ChevronDownIcon, Icon } from '@/components/ui/icon';
import { Menu, MenuItem, MenuItemLabel } from '@/components/ui/menu';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import {
    IMPORTANCE_THRESHOLDS,
    type ImportanceThreshold,
} from '@/lib/feed-ordering/importance-filter';
import { usePulse } from '@/lib/hooks/use-pulse';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, View } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

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
    /**
     * Draw a brief pulsing ring around the trigger chip. Used by the Feed's
     * "lower the feed priority" nudge on the end-of-list card: tapping it
     * reveals the header and pulses this chip to point the user at the
     * control, rather than trying to open the menu programmatically (see
     * the trigger's own comment for why that path doesn't work on native).
     * The CALLER owns turning this off again after a few seconds — it is not
     * a "pending state" indicator like the two other `usePulse` call sites,
     * just a one-shot attention nudge.
     */
    readonly pulsing?: boolean;
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
    pulsing = false,
}) => {
    const { t } = useTranslation();
    // Transient nudge, not a "something is pending" indicator — rests fully
    // transparent (0) rather than the 0.3 the other two `usePulse` call sites
    // use, since there is nothing to keep showing once `pulsing` goes false.
    const pulseAnim = usePulse(pulsing, { restWhenActive: 0 });

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
                    // min-h-10, rounded-full, px-4, text-base. RN Views default
                    // to `position: relative`, so the pulse ring below can
                    // absolutely-position against this without an extra wrapper.
                    className="flex-row items-center rounded-full border border-primary-500 min-h-10 px-4"
                >
                    {/* The "lower the priority" nudge on the Feed's end-of-list
                        card reveals the header and pulses THIS ring rather than
                        trying to open the menu itself — see `pulsing`'s doc. */}
                    {pulsing && (
                        <Animated.View
                            testID={`${testIDPrefix}-pulse`}
                            pointerEvents="none"
                            style={{
                                position: 'absolute',
                                top: -3,
                                left: -3,
                                right: -3,
                                bottom: -3,
                                borderRadius: 999,
                                borderWidth: 2,
                                borderColor: ACCENT,
                                opacity: pulseAnim,
                            }}
                        />
                    )}
                    {/* The filter glyph is what tells the reader this chip
                        FILTERS the list below (vs. being a mode/sort switch). */}
                    <MaterialIcons
                        name="filter-list"
                        size={16}
                        color={ACCENT}
                        style={{ marginRight: 6 }}
                    />
                    <Text size="md" numberOfLines={1} className="text-primary-500 font-semibold">
                        {`${t(LABEL_KEYS[value] as any)}+`}
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
                        // Compact: the template's min-w-[200px] suits text-heavy
                        // menus; three short band labels don't need it.
                        className="min-w-28 p-2.5"
                    >
                        <MenuItemLabel
                            size="sm"
                            className={selected ? 'text-primary-400 font-semibold' : ''}
                        >
                            {/* "+" = "this band and above" — script-neutral, and it
                                matches the trigger chip so the semantics are taught
                                where the choice is made. */}
                            {`${t(LABEL_KEYS[threshold] as any)}+`}
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
