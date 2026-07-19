import { ArticleCard } from '@/components/custom/ArticleCard';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import {
    Modal,
    ModalBackdrop,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import {
    deleteSavedSuggestion,
    loadSavedSuggestions,
} from '@/lib/database/services/saved-article-suggestion-service';
import logger from '@/lib/logger';
import { type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface SavedSuggestionsScreenProps {
    onBack: () => void;
}

const SavedSuggestionsScreen: React.FC<SavedSuggestionsScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const insets = useSafeAreaInsets();
    const [saved, setSaved] = useState<ForYouSuggestion[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    // The suggestion pending deletion — non-null opens the confirm dialog.
    const [confirmTarget, setConfirmTarget] = useState<ForYouSuggestion | null>(null);

    // Reload on focus so a save made elsewhere (detail screen) shows up when
    // the user navigates back here.
    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            loadSavedSuggestions()
                .then((rows) => {
                    if (!cancelled) setSaved(rows);
                })
                .catch((err) => {
                    logger.captureException(err, {
                        tags: { screen: 'SavedSuggestionsScreen', method: 'load' },
                    });
                })
                .finally(() => {
                    if (!cancelled) setIsLoading(false);
                });
            return () => {
                cancelled = true;
            };
        }, []),
    );

    const handleCardPress = useCallback((suggestion: ForYouSuggestion) => {
        router.push({
            pathname: '/logged-in/suggestion-detail',
            params: { articleSuggestionId: suggestion._id },
        });
    }, []);

    const handleConfirmDelete = useCallback(async () => {
        if (!confirmTarget) return;
        const target = confirmTarget;
        setConfirmTarget(null);
        try {
            await deleteSavedSuggestion(target._id);
            setSaved((prev) => prev.filter((s) => s._id !== target._id));
            toast.show({
                placement: 'top',
                duration: 3000,
                render: ({ id }: { id: string }) => (
                    <Toast nativeID={id} action="success" variant="solid">
                        <ToastTitle>{t('savedSuggestions.savedToastTitle')}</ToastTitle>
                        <ToastDescription>
                            {t('savedSuggestions.removedToastMessage')}
                        </ToastDescription>
                    </Toast>
                ),
            });
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'SavedSuggestionsScreen', method: 'delete' },
                extra: { id: target._id },
            });
        }
    }, [confirmTarget, toast, t]);

    const renderItem: ListRenderItem<ForYouSuggestion> = useCallback(
        ({ item }) => (
            <Box className="relative">
                <ArticleCard suggestion={item} onPress={handleCardPress} />
                <Pressable
                    onPress={() => setConfirmTarget(item)}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={t('savedSuggestions.deleteConfirmCta')}
                    className="bg-gray-900 rounded-full p-2 shadow-hard-2"
                    style={{ position: 'absolute', top: '5%', right: '5%', zIndex: 10 }}
                >
                    <MaterialIcons name="delete" size={20} color="#ffffff" />
                </Pressable>
            </Box>
        ),
        [handleCardPress, t],
    );

    const keyExtractor = useCallback(
        (item: ForYouSuggestion, index: number) => item._id || `saved-${index}`,
        [],
    );

    const ListHeader = (
        <Box
            className="mx-4 mb-4 px-3 py-2 border border-primary-500 rounded-lg bg-gray-900"
            accessibilityRole="summary"
        >
            <HStack className="items-start" space="sm">
                <MaterialIcons
                    name="info-outline"
                    size={16}
                    color="#9ca3af"
                    style={{ marginTop: 2 }}
                />
                <Text size="xs" className="text-gray-400 flex-1">
                    {t('savedSuggestions.note')}
                </Text>
            </HStack>
        </Box>
    );

    const ListEmpty = isLoading ? (
        <Box className="items-center justify-center py-20">
            <Spinner size="large" />
        </Box>
    ) : (
        <Box className="items-center justify-center py-20 px-6">
            <MaterialIcons name="bookmark-border" size={48} color="#6B7280" />
            <Text size="md" className="text-typography-400 text-center mt-4">
                {t('savedSuggestions.empty')}
            </Text>
        </Box>
    );

    return (
        <Box className="flex-1 bg-black">
            {/* Floating Back Button */}
            <Box style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 20 }}>
                <Pressable
                    onPress={onBack}
                    className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                >
                    <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                </Pressable>
            </Box>

            <VStack
                className="px-5 pb-2"
                style={{ paddingTop: insets.top + 16 }}
            >
                <Heading size="3xl" className="text-white ml-14">
                    {t('savedSuggestions.title')}
                </Heading>
            </VStack>

            <FlatList
                data={saved}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListHeaderComponent={ListHeader}
                ListEmptyComponent={ListEmpty}
                contentContainerStyle={{
                    paddingTop: 12,
                    paddingBottom: insets.bottom + 40,
                }}
                showsVerticalScrollIndicator={false}
            />

            {/* Delete confirmation (Gluestack Modal) */}
            <Modal isOpen={!!confirmTarget} onClose={() => setConfirmTarget(null)}>
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader>
                        <Heading size="md" className="text-white">
                            {t('savedSuggestions.deleteConfirmTitle')}
                        </Heading>
                    </ModalHeader>
                    <ModalBody>
                        <Text size="sm" className="text-typography-300">
                            {t('savedSuggestions.deleteConfirmMessage')}
                        </Text>
                    </ModalBody>
                    <ModalFooter>
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => setConfirmTarget(null)}
                            className="mr-3"
                        >
                            <ButtonText>{t('common.cancel')}</ButtonText>
                        </Button>
                        <Button action="negative" onPress={handleConfirmDelete}>
                            <ButtonText>{t('savedSuggestions.deleteConfirmCta')}</ButtonText>
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </Box>
    );
};

export default SavedSuggestionsScreen;
