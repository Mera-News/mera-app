import { GLASS_OVER_CONTENT_FILL, TranslucentPlate } from '@/components/custom/GlassSurface';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ACCENT = '#EDA77E';
const ROW_STYLE = { minHeight: 48, justifyContent: 'center' } as const;
const CANCEL_STYLE = {
    minHeight: 48,
    marginTop: 8,
    marginHorizontal: 8,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
} as const;

export interface ArticleMenuItem {
    /** Stable key; also the VoiceOver custom action name. */
    key: string;
    label: string;
    /** A MaterialIcons glyph, or a custom node (the Mera mark for Ask). */
    icon: keyof typeof MaterialIcons.glyphMap | React.ReactNode;
    testID: string;
    /** Runs AFTER the menu has closed. Return false (or throw) to report a
     *  failure; the host then offers a retry. */
    run: () => void | boolean | Promise<void | boolean>;
}

interface ArticleOverflowMenuProps {
    visible: boolean;
    /** The article's headline, as the sheet's title (one line). */
    title?: string;
    onClose: () => void;
    items: readonly ArticleMenuItem[];
    /** Called with the picked item; the host runs it once the sheet is gone. */
    onPick: (item: ArticleMenuItem) => void;
}

/**
 * The shared ••• sheet for every article surface (D3). Presentational: the
 * item list and what each item does come from `useArticleMenu`, so the card,
 * the compact row and the detail screen cannot drift apart.
 *
 * A titled sheet over CONTENT, so it carries the dark over-content base (a
 * bare translucent plate over headlines is unreadable), and it has an explicit
 * Cancel (F38: the old long-press sheet had neither title nor Cancel).
 */
const ArticleOverflowMenu: React.FC<ArticleOverflowMenuProps> = (props) =>
    // The sheet (and its safe-area read) mounts only while open: this sits
    // under every card, and a closed menu must cost nothing.
    props.visible ? <ArticleOverflowSheet {...props} /> : null;

const ArticleOverflowSheet: React.FC<ArticleOverflowMenuProps> = ({ title, onClose, items, onPick }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    return (
        <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
            <Pressable
                accessibilityLabel={t('common.cancel')}
                onPress={onClose}
                style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', justifyContent: 'flex-end' }}
                testID="article-menu-backdrop"
            >
                <Pressable onPress={() => {}} style={{ width: '100%' }} accessible={false}>
                    <Box
                        className="rounded-t-3xl overflow-hidden border-t border-white/10"
                        style={{ backgroundColor: GLASS_OVER_CONTENT_FILL }}
                    >
                        {/* Plate first on an UNPADDED box: the plate absolute-fills its
                            parent's CONTENT box, so padding there leaves an
                            unplated frame. */}
                        <TranslucentPlate />
                        <Box
                            className="px-2 pt-3"
                            // Clear the home indicator: the sheet sits over the tab bar.
                            style={{ paddingBottom: insets.bottom + 12 }}
                            testID="article-menu"
                        >
                            {/* The headline, so the reader knows which story the
                                actions are for; the generic label only when
                                there is none. */}
                            <Text
                                testID="article-menu-title"
                                size="sm"
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                className="px-4 pb-2"
                                style={{ color: 'rgb(212,212,212)', fontWeight: '600' }}
                                accessibilityRole="header"
                            >
                                {title?.trim() ? title.trim() : t('articleMenu.title')}
                            </Text>
                            <VStack space="xs">
                                {items.map((item) => (
                                    <Pressable
                                        key={item.key}
                                        testID={item.testID}
                                        accessibilityRole="button"
                                        accessibilityLabel={item.label}
                                        onPress={() => onPick(item)}
                                    >
                                        {/* Layout on an inner View with a STATIC style: a
                                            function `style` on this Pressable is dropped on
                                            device (the css-interop wrapper), which is how
                                            Cancel lost its plate once. */}
                                        <View style={ROW_STYLE}>
                                        <HStack className="items-center px-4" space="md">
                                            {typeof item.icon === 'string' ? (
                                                <MaterialIcons
                                                    name={item.icon as keyof typeof MaterialIcons.glyphMap}
                                                    size={22}
                                                    color={ACCENT}
                                                />
                                            ) : (
                                                item.icon
                                            )}
                                            <Text className="flex-1 text-white" style={{ fontSize: 15, fontWeight: '600' }}>
                                                {item.label}
                                            </Text>
                                        </HStack>
                                        </View>
                                    </Pressable>
                                ))}
                                <Pressable
                                    testID="article-menu-cancel"
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.cancel')}
                                    onPress={onClose}
                                >
                                    {/* A visible full-width button inside the sheet's
                                        inset, label centred (it was plain text at the
                                        sheet's left edge, 24pt tall). */}
                                    <View testID="article-menu-cancel-plate" style={CANCEL_STYLE}>
                                        <Text className="text-white" style={{ fontSize: 15, fontWeight: '600', textAlign: 'center' }}>
                                            {t('common.cancel')}
                                        </Text>
                                    </View>
                                </Pressable>
                            </VStack>
                        </Box>
                    </Box>
                </Pressable>
            </Pressable>
        </Modal>
    );
};

export default ArticleOverflowMenu;
