import { useIsToastFront } from '@/components/ui/toast';
import { tint, useColors, useThemeMode, type ThemeColors } from '@/lib/theme/tokens';
import { Bell, Check, CircleAlert, Info, TriangleAlert, type LucideIcon } from 'lucide-react-native';
import React, { useEffect } from 'react';
import { AccessibilityInfo, Pressable, Text, View, useWindowDimensions } from 'react-native';
import IndeterminateBar from './IndeterminateBar';

/**
 * THE TOAST. Every in-app toast is this component: callers pass a tone, a
 * title, an optional body, up to two actions and an optional progress bar.
 * Width, wrapping and where the actions go are decided here, never by a caller
 * (design "Toasts and notifications", Anatomy board).
 *
 * WIDTH IS FIXED, never the text's: `min(window - 32, 440)`. The old toast took
 * its text's intrinsic width under a 60% cap with a `flexShrink` column, so an
 * action beside the text squeezed it to one word per line. With a fixed width
 * the text column can be `flex: 1, minWidth: 0` and always gets the rest.
 *
 * Styles only, no class names: the manager builds trees with createElement and
 * a class on such a tree once rendered invisible text (and an HStack an empty
 * pill). Colours come from the semantic tokens; Pressables take static styles
 * (a function style is dropped on device).
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';
export const TOAST_TONES: readonly ToastTone[] = ['info', 'success', 'warning', 'error', 'neutral'];

export interface ToastActionSpec {
    label: string;
    onPress: () => void;
    /** A filled pill; the rest are outlined. Ignored for the inline text action. */
    primary?: boolean;
    testID?: string;
}

export interface MeraToastProps {
    tone: ToastTone;
    /** Overrides the tone's own glyph (a Bookmark for "Saved", a Star for "Mera updated"). */
    icon?: LucideIcon;
    title: string;
    body?: string;
    /** At most two are drawn. */
    actions?: readonly ToastActionSpec[];
    /** Work in flight: a 3px bar along the bottom edge, still under Reduce Motion and Lite. */
    progress?: boolean;
    progressTestID?: string;
    /** What a screen reader hears when the card reaches the front (default: title, then body). */
    announcement?: string;
}

export const TOAST_RADIUS = 18;
const MAX_WIDTH = 440;
const SIDE_GUTTER = 16;
/** The minimum tap frame, each way. */
const TARGET_PT = 44;
const PILL_HEIGHT = 36;
const BADGE = 32;

/** The toast's width on a window this wide. */
export function toastWidth(windowWidth: number): number {
    return Math.min(windowWidth - 2 * SIDE_GUTTER, MAX_WIDTH);
}

/** Shape-distinct glyphs, so the tone does not rest on colour alone. */
const TONE_ICON: Record<ToastTone, LucideIcon> = {
    info: Info,
    success: Check,
    warning: TriangleAlert,
    error: CircleAlert,
    neutral: Bell,
};

export function toneColor(tone: ToastTone, c: ThemeColors): string {
    switch (tone) {
        case 'success':
            return c.positive;
        case 'error':
            return c.negative;
        case 'warning':
            return c.warning;
        case 'info':
            return c.info;
        default:
            return c.ink;
    }
}

/** The round tone badge, shared with the inbox row and the notification sheet. */
export function ToneBadge({ tone, icon, size = BADGE }: { tone: ToastTone; icon?: LucideIcon; size?: number }) {
    const c = useColors();
    const light = useThemeMode() === 'light';
    const Glyph = icon ?? TONE_ICON[tone];
    const color = toneColor(tone, c);
    return (
        <View
            testID="mera-toast-badge"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: tone === 'neutral' ? tint(c.ink, 0.1) : tint(color, light ? 0.12 : 0.16),
            }}
        >
            <Glyph size={Math.round(size * 0.5625)} color={color} strokeWidth={2} />
        </View>
    );
}

export default function MeraToast({
    tone,
    icon,
    title,
    body,
    actions = [],
    progress = false,
    progressTestID,
    announcement,
}: MeraToastProps) {
    const c = useColors();
    const light = useThemeMode() === 'light';
    const width = toastWidth(useWindowDimensions().width);
    const isFront = useIsToastFront();
    const spoken = announcement ?? (body ? `${title}. ${body}` : title);

    useEffect(() => {
        // FRONT CARD ONLY: a card waiting behind another is an unreadable strip.
        if (isFront) AccessibilityInfo.announceForAccessibility(spoken);
    }, [spoken, isFront]);

    const shown = actions.slice(0, 2);
    // Title only with at most one action: one centred row, the action inline at its end.
    const compact = !body && shown.length <= 1;
    const inline = compact ? shown[0] : undefined;
    const pills = compact ? [] : [...shown.filter((a) => !a.primary), ...shown.filter((a) => a.primary)];

    return (
        <View
            testID="mera-toast"
            style={{
                width,
                borderRadius: TOAST_RADIUS,
                // On the Root, never the clipping surface: a view that clips casts no shadow.
                boxShadow: light ? '0px 14px 34px rgba(30,20,10,0.16)' : '0px 14px 34px rgba(0,0,0,0.5)',
            }}
        >
            <View
                style={{
                    borderRadius: TOAST_RADIUS,
                    overflow: 'hidden',
                    borderWidth: 1,
                    borderColor: c.line,
                    backgroundColor: c.panel,
                    paddingTop: compact ? 10 : 14,
                    paddingBottom: compact ? 10 : 14,
                    paddingLeft: 14,
                    paddingRight: 16,
                    gap: 12,
                }}
            >
                <View
                    style={{
                        flexDirection: 'row',
                        gap: 12,
                        alignItems: compact ? 'center' : 'flex-start',
                        minHeight: compact ? TARGET_PT : undefined,
                    }}
                >
                    <ToneBadge tone={tone} icon={icon} />
                    <View
                        testID="mera-toast-text"
                        accessible
                        accessibilityRole="alert"
                        accessibilityLabel={spoken}
                        style={{ flex: 1, minWidth: 0, gap: 2, paddingTop: compact ? 0 : 5 }}
                    >
                        <Text numberOfLines={2} style={{ color: c.ink, fontSize: 15, lineHeight: 20, fontWeight: '600' }}>
                            {title}
                        </Text>
                        {body ? (
                            <Text numberOfLines={3} style={{ color: c.ink2, fontSize: 14, lineHeight: 20 }}>
                                {body}
                            </Text>
                        ) : null}
                    </View>
                    {inline ? (
                        <Pressable
                            testID={inline.testID}
                            accessibilityRole="button"
                            accessibilityLabel={inline.label}
                            onPress={inline.onPress}
                            style={{
                                minHeight: TARGET_PT,
                                minWidth: TARGET_PT,
                                paddingHorizontal: 6,
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <Text
                                style={{
                                    color: c.accentText,
                                    fontSize: 15,
                                    lineHeight: 20,
                                    fontWeight: '600',
                                    textDecorationLine: 'underline',
                                }}
                            >
                                {inline.label}
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
                {pills.length > 0 ? (
                    <View testID="mera-toast-actions" style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                        {pills.map((action) => (
                            <Pressable
                                key={action.label}
                                testID={action.testID}
                                accessibilityRole="button"
                                accessibilityLabel={action.label}
                                onPress={action.onPress}
                                // A 44pt frame given back by margins around the 36pt pill.
                                style={{
                                    minHeight: TARGET_PT,
                                    marginVertical: -(TARGET_PT - PILL_HEIGHT) / 2,
                                    justifyContent: 'center',
                                }}
                            >
                                <View
                                    testID={action.testID ? `${action.testID}-pill` : undefined}
                                    style={{
                                        height: PILL_HEIGHT,
                                        paddingHorizontal: 18,
                                        borderRadius: 9999,
                                        justifyContent: 'center',
                                        borderWidth: action.primary ? 0 : 1,
                                        borderColor: tint(c.ink, 0.18),
                                        backgroundColor: action.primary ? c.accent : tint(c.ink, 0.06),
                                    }}
                                >
                                    <Text
                                        style={{
                                            color: action.primary ? c.onAccent : c.ink,
                                            fontSize: 15,
                                            lineHeight: 20,
                                            fontWeight: '600',
                                        }}
                                    >
                                        {action.label}
                                    </Text>
                                </View>
                            </Pressable>
                        ))}
                    </View>
                ) : null}
                {progress ? (
                    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
                        <IndeterminateBar
                            width={width - 2}
                            height={3}
                            color={c.accent}
                            trackColor={tint(c.ink, 0.06)}
                            testID={progressTestID}
                        />
                    </View>
                ) : null}
            </View>
        </View>
    );
}
