import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, View } from 'react-native';

export const HUB_ACCENT = '#E78A53';
export const HUB_ACCENT_SOFT = '#F2BFA0';
const MUTED = '#A3A3A3';

/** A forward chevron that points the reading direction (mirrored in RTL). */
export const ForwardChevron: React.FC<{ readonly color?: string; readonly size?: number }> = ({
    color = HUB_ACCENT,
    size = 18,
}) => (
    <MaterialIcons
        name="chevron-right"
        size={size}
        color={color}
        style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}
    />
);

/** The "?" is a 26pt circle in a 44pt frame that bleeds 9pt on every side,
 *  so the header row keeps the circle's own height. */
const HINT_GLYPH = 26;
const HINT_FRAME = 44;
const HINT_BLEED = -(HINT_FRAME - HINT_GLYPH) / 2;

export interface CardHint {
    readonly title: string;
    readonly paragraphs: readonly string[];
}

/** The short hint box over the dimmed page: title, short paragraphs, Got it. */
export const HintBox: React.FC<{ readonly hint: CardHint; readonly isOpen: boolean; readonly onClose: () => void; readonly testID: string }> = ({
    hint,
    isOpen,
    onClose,
    testID,
}) => {
    const { t } = useTranslation();
    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md">
            <ModalBackdrop />
            <ModalContent testID={testID}>
                <ModalHeader>
                    <Heading size="lg" className="text-white" accessibilityRole="header">
                        {hint.title}
                    </Heading>
                </ModalHeader>
                <ModalBody>
                    <VStack space="md">
                        {hint.paragraphs.map((p) => (
                            <Text key={p} size="sm" style={{ color: 'rgb(212, 212, 212)' }}>
                                {p}
                            </Text>
                        ))}
                    </VStack>
                </ModalBody>
                <ModalFooter>
                    <Button variant="outline" className="flex-1 border-white/30" onPress={onClose} testID={`${testID}-close`}>
                        <ButtonText className="text-white">{t('configPanel.gotIt')}</ButtonText>
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
};

interface HubCardProps {
    readonly testID: string;
    readonly title: string;
    /** Orange count pill after the title (Profile cleanup). */
    readonly badgeCount?: number;
    readonly hint: CardHint;
    /** The full-width bottom row. */
    readonly viewAll?: { readonly label: string; readonly onPress: () => void };
    readonly children: React.ReactNode;
}

/**
 * One Profile hub card: title (+ optional count), a "?" that opens a hint
 * box, the rows, and a full-width "View all" row along the bottom edge. No
 * dividers between rows.
 */
const HubCard: React.FC<HubCardProps> = ({ testID, title, badgeCount, hint, viewAll, children }) => {
    const { t } = useTranslation();
    const [hintOpen, setHintOpen] = useState(false);
    // A modal opened inside a tab screen survives a tab switch: close it.
    const focused = useIsFocusedSafe();
    useEffect(() => {
        if (!focused) setHintOpen(false);
    }, [focused]);
    return (
        <View
            testID={testID}
            style={{
                borderRadius: 16,
                backgroundColor: 'rgba(255,255,255,0.06)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.10)',
                overflow: 'hidden',
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 12, paddingHorizontal: 14, paddingBottom: 6, gap: 8 }}>
                <Text accessibilityRole="header" style={{ flex: 1, color: '#ffffff', fontSize: 16, fontWeight: '700' }}>
                    {title}
                </Text>
                {badgeCount ? (
                    <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: HUB_ACCENT }}>
                        <Text scaleTier="chrome" style={{ color: '#121113', fontSize: 12, fontWeight: '700' }}>
                            {badgeCount}
                        </Text>
                    </View>
                ) : null}
                <Pressable
                    testID={`${testID}-hint`}
                    onPress={() => setHintOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={t('you.profile.aboutA11y', { card: title })}
                    style={{ width: HINT_FRAME, height: HINT_FRAME, margin: HINT_BLEED, alignItems: 'center', justifyContent: 'center' }}
                >
                    <View
                        style={{
                            width: HINT_GLYPH,
                            height: HINT_GLYPH,
                            borderRadius: HINT_GLYPH / 2,
                            borderWidth: 1.5,
                            borderColor: 'rgba(255,255,255,0.32)',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <Text scaleTier="locked" style={{ color: '#D4D4D4', fontSize: 14, fontWeight: '700' }}>
                            ?
                        </Text>
                    </View>
                </Pressable>
            </View>
            {children}
            {viewAll ? (
                <Pressable
                    testID={`${testID}-view-all`}
                    onPress={viewAll.onPress}
                    accessibilityRole="button"
                    accessibilityLabel={viewAll.label}
                    style={{
                        minHeight: 44,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderTopWidth: 1,
                        borderTopColor: 'rgba(255,255,255,0.07)',
                    }}
                >
                    <Text style={{ color: HUB_ACCENT, fontSize: 14, fontWeight: '600' }}>{viewAll.label}</Text>
                    <ForwardChevron size={16} />
                </Pressable>
            ) : null}
            <HintBox hint={hint} isOpen={hintOpen} onClose={() => setHintOpen(false)} testID={`${testID}-hint-box`} />
        </View>
    );
};

/** One row inside a card: text on the start side, a value or chip on the end. */
export const HubRow: React.FC<{ readonly children: React.ReactNode; readonly trailing?: React.ReactNode; readonly testID?: string }> = ({
    children,
    trailing,
    testID,
}) => (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 14, gap: 10 }}>
        <View style={{ flex: 1 }}>{children}</View>
        {trailing}
    </View>
);

export const HubValue: React.FC<{ readonly children: React.ReactNode }> = ({ children }) => (
    <Text numberOfLines={1} style={{ color: MUTED, fontSize: 14 }}>
        {children}
    </Text>
);

export const HubEmpty: React.FC<{ readonly children: React.ReactNode; readonly testID?: string }> = ({ children, testID }) => (
    <Text testID={testID} style={{ color: '#D4D4D4', fontSize: 14, paddingVertical: 10, paddingHorizontal: 14 }}>
        {children}
    </Text>
);

export default HubCard;
