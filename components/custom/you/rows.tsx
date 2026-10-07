// The grouped list look shared by the You pages and Settings: a rounded group
// card, rows inside it (title, optional sub-line, trailing value, badge or
// chevron), a small intro line under a page title, and a section label.
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { I18nManager, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

/** A forward chevron that points the reading direction (mirrored in RTL). */
export const ForwardChevron: React.FC<{ readonly color?: string; readonly size?: number }> = ({ color, size = 18 }) => {
    const colors = useColors();
    return (
        <MaterialIcons
            name="chevron-right"
            size={size}
            color={color ?? colors.ink3}
            style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}
        />
    );
};

/** A rounded card holding rows, with a hairline between them. */
export const Group: React.FC<{
    readonly children: React.ReactNode;
    readonly testID?: string;
    readonly style?: StyleProp<ViewStyle>;
}> = ({ children, testID, style }) => {
    const colors = useColors();
    const rows = React.Children.toArray(children).filter(Boolean);
    return (
        <View
            testID={testID}
            style={[
                { borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
                style,
            ]}
        >
            {rows.map((row, i) => (
                <View
                    key={i}
                    style={i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line } : undefined}
                >
                    {row}
                </View>
            ))}
        </View>
    );
};

export interface RowProps {
    readonly title: string;
    /** User data (a fact, a place name): translated on the fly, never `t()`. */
    readonly translatable?: boolean;
    readonly bold?: boolean;
    readonly titleColor?: string;
    readonly subtitle?: string;
    /** Grey text on the trailing side ("5 topics", "Off"). */
    readonly value?: string;
    /** Anything else on the trailing side (a badge, a switch). */
    readonly trailing?: React.ReactNode;
    readonly leadingIcon?: keyof typeof MaterialIcons.glyphMap;
    /** Makes the row a button (with a chevron unless `hideChevron`). */
    readonly onPress?: () => void;
    readonly hideChevron?: boolean;
    readonly titleLines?: number;
    readonly testID?: string;
}

export const Row: React.FC<RowProps> = ({
    title,
    translatable = false,
    bold = false,
    titleColor,
    subtitle,
    value,
    trailing,
    leadingIcon,
    onPress,
    hideChevron = false,
    titleLines = 2,
    testID,
}) => {
    const colors = useColors();
    const titleStyle = { color: titleColor ?? colors.ink, fontSize: 16, lineHeight: 21, fontWeight: bold ? '700' : '400' } as const;
    const body = (
        <View style={styles.row}>
            {leadingIcon ? <MaterialIcons name={leadingIcon} size={20} color={colors.ink2} /> : null}
            <View style={styles.text}>
                {translatable ? (
                    <TranslatableDynamic text={title} size="md" style={titleStyle} numberOfLines={titleLines} />
                ) : (
                    <Text style={titleStyle} numberOfLines={titleLines}>
                        {title}
                    </Text>
                )}
                {subtitle ? (
                    <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{subtitle}</Text>
                ) : null}
            </View>
            {value ? (
                <Text style={{ color: colors.ink2, fontSize: 15 }} numberOfLines={1}>
                    {value}
                </Text>
            ) : null}
            {trailing}
            {onPress && !hideChevron ? <ForwardChevron /> : null}
        </View>
    );
    if (!onPress) return <View testID={testID}>{body}</View>;
    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={[title, subtitle, value].filter(Boolean).join(', ')}
        >
            {body}
        </Pressable>
    );
};

/** A small rounded count or label in the accent (Tidy up "1", a place's role). */
export const Badge: React.FC<{ readonly label: string; readonly icon?: keyof typeof MaterialIcons.glyphMap }> = ({
    label,
    icon,
}) => {
    const colors = useColors();
    return (
        <View style={styles.badge}>
            <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.accent, opacity: 0.16 }]} />
            {icon ? <MaterialIcons name={icon} size={13} color={colors.accentText} /> : null}
            <Text scaleTier="chrome" style={{ color: colors.accentText, fontSize: 12, fontWeight: '600' }}>
                {label}
            </Text>
        </View>
    );
};

/** "View all 4 ›", centred under a group's rows. */
export const ViewAll: React.FC<{ readonly label: string; readonly onPress: () => void; readonly testID?: string }> = ({
    label,
    onPress,
    testID,
}) => {
    const colors = useColors();
    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={{ height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2 }}
        >
            <Text style={{ color: colors.accentText, fontSize: 14, fontWeight: '600' }}>{label}</Text>
            <ForwardChevron size={16} color={colors.accentText} />
        </Pressable>
    );
};

/** The grey line under a page title. */
export const Help: React.FC<{ readonly children: React.ReactNode }> = ({ children }) => {
    const colors = useColors();
    return <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginHorizontal: 4 }}>{children}</Text>;
};

/** A group's label above it ("General", "Privacy and security"). */
export const GroupLabel: React.FC<{ readonly children: string; readonly color?: string; readonly testID?: string }> = ({
    children,
    color,
    testID,
}) => {
    const colors = useColors();
    return (
        <Text
            testID={testID}
            accessibilityRole="header"
            style={{ color: color ?? colors.ink2, fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 6, marginHorizontal: 4 }}
        >
            {children}
        </Text>
    );
};

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 10, paddingHorizontal: 16 },
    text: { flex: 1, minWidth: 0 },
    badge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        height: 22,
        paddingHorizontal: 8,
        borderRadius: 999,
        overflow: 'hidden',
    },
});
