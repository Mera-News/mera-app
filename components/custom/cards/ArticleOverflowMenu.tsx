import { GLASS_OVER_CONTENT_FILL, TranslucentPlate } from '@/components/custom/GlassSurface';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable } from 'react-native';

const ACCENT = '#EDA77E';

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
const ArticleOverflowMenu: React.FC<ArticleOverflowMenuProps> = ({ visible, onClose, items, onPick }) => {
    const { t } = useTranslation();
    if (!visible) return null;
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
                        {/* Plate first on an UNPADDED box; see CompactActionsSheet. */}
                        <TranslucentPlate />
                        <Box className="px-2 pb-8 pt-3" testID="article-menu">
                            <Text
                                size="sm"
                                className="text-typography-400 px-4 pb-2"
                                accessibilityRole="header"
                            >
                                {t('articleMenu.title')}
                            </Text>
                            <VStack space="xs">
                                {items.map((item) => (
                                    <Pressable
                                        key={item.key}
                                        testID={item.testID}
                                        accessibilityRole="button"
                                        accessibilityLabel={item.label}
                                        onPress={() => onPick(item)}
                                        style={({ pressed }) => ({
                                            minHeight: 48,
                                            borderRadius: 16,
                                            justifyContent: 'center',
                                            opacity: pressed ? 0.7 : 1,
                                        })}
                                    >
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
                                    </Pressable>
                                ))}
                                <Pressable
                                    testID="article-menu-cancel"
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.cancel')}
                                    onPress={onClose}
                                    style={({ pressed }) => ({
                                        minHeight: 48,
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        marginTop: 4,
                                        opacity: pressed ? 0.7 : 1,
                                    })}
                                >
                                    <Text className="text-typography-300" style={{ fontSize: 15 }}>
                                        {t('common.cancel')}
                                    </Text>
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
