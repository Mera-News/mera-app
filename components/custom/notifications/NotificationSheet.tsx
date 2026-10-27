import { ToneBadge, type ToastTone } from '@/components/custom/toast/MeraToast';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { tint, useColors } from '@/lib/theme/tokens';
import type { LucideIcon } from 'lucide-react-native';
import React, { useCallback, useEffect, useRef } from 'react';
import { Pressable, Text, View } from 'react-native';

export interface NotificationSheetAction {
    label: string;
    /** Runs once the sheet has gone, never on the tap. */
    onPress: () => void;
    /** Filled; the rest are outlined. */
    primary?: boolean;
    testID: string;
}

interface NotificationSheetProps {
    open: boolean;
    /** Scrim, drag down, back, or an action: the parent sets `open` false. */
    onClose: () => void;
    /** The sheet is fully gone (after any action it ran). */
    onClosed?: () => void;
    tone: ToastTone;
    icon?: LucideIcon;
    title: string;
    /** The notice's age, under the title. */
    age?: string;
    body?: string;
    /** More to read, between the body and the actions. */
    children?: React.ReactNode;
    actions: readonly NotificationSheetAction[];
    testID: string;
}

/** If the sheet never reports it has gone, run the action anyway after this long. */
const DISMISS_FALLBACK_MS = 1200;
const BUTTON_HEIGHT = 50;

/**
 * A notice opened from its inbox row when there is a choice or more to read
 * (design "Notification sheet", "What's new"): a 40 tone badge, a 20pt title
 * with the age under it, the body, then full-width actions, primary filled,
 * the rest outlined. Drawn on the one BottomSheet, so it wears ModalMaterial.
 *
 * An action CLOSES the sheet and runs once it has gone (BottomSheet
 * `onClosed`), at DISMISS_FALLBACK_MS if that never comes, or on unmount,
 * exactly once: iOS drops native UI presented while a Modal is leaving.
 */
export default function NotificationSheet({
    open,
    onClose,
    onClosed,
    tone,
    icon,
    title,
    age,
    body,
    children,
    actions,
    testID,
}: NotificationSheetProps) {
    const c = useColors();
    const pending = useRef<(() => void) | null>(null);
    const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flush = useCallback(() => {
        if (fallback.current) clearTimeout(fallback.current);
        fallback.current = null;
        const run = pending.current;
        pending.current = null;
        run?.();
    }, []);
    useEffect(() => flush, [flush]);

    const press = (action: NotificationSheetAction) => {
        pending.current = action.onPress;
        onClose();
        if (fallback.current) clearTimeout(fallback.current);
        fallback.current = setTimeout(flush, DISMISS_FALLBACK_MS);
    };

    return (
        <BottomSheet
            open={open}
            onClose={onClose}
            onClosed={() => {
                flush();
                onClosed?.();
            }}
            testID={testID}
        >
            <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14 }}>
                    <ToneBadge tone={tone} icon={icon} size={40} />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 20, lineHeight: 26, fontWeight: '700' }}>
                            {title}
                        </Text>
                        {age ? <Text style={{ color: c.ink3, fontSize: 13, lineHeight: 18 }}>{age}</Text> : null}
                    </View>
                </View>
                {body ? <Text style={{ color: c.ink2, fontSize: 16, lineHeight: 24 }}>{body}</Text> : null}
                {children}
                <View style={{ gap: 8, marginTop: 4 }}>
                    {actions.map((action) => (
                        <Pressable
                            key={action.testID}
                            testID={action.testID}
                            accessibilityRole="button"
                            accessibilityLabel={action.label}
                            onPress={() => press(action)}
                            // Static styles: a function style is dropped on device.
                            style={{
                                height: BUTTON_HEIGHT,
                                borderRadius: 9999,
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderWidth: action.primary ? 0 : 1,
                                borderColor: tint(c.ink, 0.16),
                                backgroundColor: action.primary ? c.accent : tint(c.ink, 0.06),
                            }}
                        >
                            <Text style={{ color: action.primary ? c.onAccent : c.ink, fontSize: 17, lineHeight: 22, fontWeight: '600' }}>
                                {action.label}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            </View>
        </BottomSheet>
    );
}
