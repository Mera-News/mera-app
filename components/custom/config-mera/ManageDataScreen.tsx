import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { authClient, clearAuthStorage } from '@/lib/auth-client';
import database from '@/lib/database';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { clearAllVisits } from '@/lib/database/services/publication-visit-service';
import * as scoringPipeline from '@/lib/services/scoring-pipeline';
import { clearAllStores, useForYouStore } from '@/lib/stores';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useDeleteAccountModal, useUIStore } from '@/lib/stores/ui-store';
import { MaterialIcons } from '@expo/vector-icons';
import { Q } from '@nozbe/watermelondb';
import { router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

type DataAction =
    | 'feedCache'
    | 'factsTopics'
    | 'viewingHistory'
    | 'wipeAll'
    | null;

// Where the data an action clears actually lives. Surfaced as a chip on each
// row so the on-device vs server distinction is unmistakable.
type DataLocation = 'device' | 'server';

interface ManageDataScreenProps {
    onBack?: () => void;
}

// Local-only tables that make up the ephemeral article feed cache. Rebuilt
// from the server on the next sync.
const FEED_CACHE_TABLES = [
    'article_suggestions',
    'article_suggestion_facts',
    'inference_jobs',
];

// Facts hold the user's topics in `metadata_json`, and the feed cache is built
// from those topics — so clearing facts must also clear the derived cache (and
// its topic-gen jobs) to avoid leaving stale or orphaned rows behind.
const FACTS_AND_TOPICS_TABLES = ['facts', ...FEED_CACHE_TABLES];

const ManageDataScreen: React.FC<ManageDataScreenProps> = ({ onBack }) => {
    const insets = useSafeAreaInsets();
    const toast = useToast();
    const { t } = useTranslation();
    const [confirmAction, setConfirmAction] = useState<DataAction>(null);
    const [isProcessing, setIsProcessing] = useState(false);

    const deleteAccountModal = useDeleteAccountModal();
    const { openModal, closeModal, setDeleteAccountStep, setModalProcessing } = useUIStore();
    const showDeleteInitial = deleteAccountModal.isOpen && deleteAccountModal.step === 'initial';
    const showDeleteConfirm = deleteAccountModal.isOpen && deleteAccountModal.step === 'confirm';
    const isDeletingAccount = deleteAccountModal.isProcessing;

    const deleteTables = useCallback(async (tableNames: string[]) => {
        await database.write(async () => {
            const batches = await Promise.all(
                tableNames.map(async (table) => {
                    const records = await database.get(table).query(Q.where('id', Q.notEq(''))).fetch();
                    return records.map((r) => r.prepareDestroyPermanently());
                }),
            );
            await database.batch(batches.flat());
        });
    }, []);

    const showErrorToast = useCallback(() => {
        toast.show({
            placement: 'top',
            render: () => (
                <Toast action="error" variant="solid">
                    <ToastTitle>{t('manageData.errorTitle')}</ToastTitle>
                    <ToastDescription>{t('manageData.errorDescription')}</ToastDescription>
                </Toast>
            ),
        });
    }, [toast, t]);

    const showSuccessToast = useCallback(() => {
        toast.show({
            placement: 'top',
            render: () => (
                <Toast action="success" variant="solid">
                    <ToastTitle>{t('manageData.deletedTitle')}</ToastTitle>
                    <ToastDescription>{t('manageData.deletedDescription')}</ToastDescription>
                </Toast>
            ),
        });
    }, [toast, t]);

    const handleConfirm = useCallback(async () => {
        const action = confirmAction;
        setConfirmAction(null);
        setIsProcessing(true);

        try {
            switch (action) {
                case 'feedCache': {
                    await deleteTables(FEED_CACHE_TABLES);
                    await useForYouStore.getState().clearData();
                    // The persisted feed order points at now-gone suggestions —
                    // clear it so the feed rebuilds cleanly from the re-sync.
                    useFeedOrderStore.getState().reset();
                    // Deleting article_suggestions leaves the persisted scoring
                    // run pointing at now-gone rows; without clearing it, its
                    // stuck batches keep getPipelineStatus()==='running' forever
                    // and every feed-sync bails (the clear-feed deadlock). Abort
                    // AFTER clearData so its markProcessingRunFinished stamp is
                    // not reset to null (clearData nulls it), and BEFORE the sync
                    // so the pipeline reads idle.
                    await scoringPipeline.abortRun('cache-clear');
                    if (!useSchedulerStore.getState().isRunning('feed-sync')) {
                        void AppScheduler.trigger('feed-sync');
                    }
                    break;
                }
                case 'factsTopics': {
                    await deleteTables(FACTS_AND_TOPICS_TABLES);
                    await useForYouStore.getState().clearData();
                    // The persisted feed order points at now-gone suggestions —
                    // clear it so the feed rebuilds cleanly from the re-sync.
                    useFeedOrderStore.getState().reset();
                    // Same clear-feed deadlock guard as the feedCache case — the
                    // orphaned run must be force-cleared before re-syncing.
                    await scoringPipeline.abortRun('cache-clear');
                    if (!useSchedulerStore.getState().isRunning('feed-sync')) {
                        void AppScheduler.trigger('feed-sync');
                    }
                    break;
                }
                case 'viewingHistory': {
                    await clearAllVisits();
                    break;
                }
                case 'wipeAll': {
                    await clearAllStores();
                    break;
                }
            }

            showSuccessToast();
        } catch {
            showErrorToast();
        } finally {
            setIsProcessing(false);
        }
    }, [confirmAction, deleteTables, showSuccessToast, showErrorToast]);

    const handleDeleteAccount = useCallback(async () => {
        let serverDeleteSucceeded = false;
        try {
            setModalProcessing('deleteAccount', true);
            closeModal('deleteAccount');

            await authClient.deleteUser();
            serverDeleteSucceeded = true;

            try {
                await authClient.signOut();
                await clearAuthStorage();

                router.dismissAll();
                router.replace('/');

                await new Promise((resolve) => setTimeout(resolve, 0));
                await clearAllStores();
            } catch (postDeleteError) {
                console.warn('[DeleteAccount] local cleanup failed after server delete', postDeleteError);
            }

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('preferences.accountDeletedTitle')}</ToastTitle>
                        <ToastDescription>{t('preferences.accountDeletedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            if (!serverDeleteSucceeded) {
                toast.show({
                    placement: 'top',
                    render: () => (
                        <Toast action="error" variant="solid">
                            <ToastTitle>{t('preferences.deletionFailedTitle')}</ToastTitle>
                            <ToastDescription>{t('preferences.deletionFailedDescription')}</ToastDescription>
                        </Toast>
                    ),
                });
            }
        } finally {
            setModalProcessing('deleteAccount', false);
        }
    }, [closeModal, setModalProcessing, toast, t]);

    type OptionEntry = {
        id: Exclude<DataAction, null>;
        title: string;
        description: string;
        modalDescription: string;
        icon: keyof typeof MaterialIcons.glyphMap;
        location: DataLocation;
    };

    type AccountEntry = {
        id: 'deleteAccount';
        title: string;
        description: string;
        icon: keyof typeof MaterialIcons.glyphMap;
        location: DataLocation;
        onPress: () => void;
    };

    const options: (OptionEntry | AccountEntry)[] = [
        {
            id: 'feedCache',
            title: t('manageData.feedCacheTitle'),
            description: t('manageData.feedCacheDescription'),
            modalDescription: t('manageData.feedCacheModalDescription'),
            icon: 'article',
            location: 'device',
        },
        {
            id: 'factsTopics',
            title: t('manageData.factsTitle'),
            description: t('manageData.factsDescription'),
            modalDescription: t('manageData.factsModalDescription'),
            icon: 'psychology',
            location: 'device',
        },
        {
            id: 'viewingHistory',
            title: t('manageData.viewingHistoryTitle'),
            description: t('manageData.viewingHistoryDescription'),
            modalDescription: t('manageData.viewingHistoryModalDescription'),
            icon: 'visibility-off',
            location: 'device',
        },
        {
            id: 'wipeAll',
            title: t('manageData.wipeAllTitle'),
            description: t('manageData.wipeAllDescription'),
            modalDescription: t('manageData.wipeAllModalDescription'),
            icon: 'delete-sweep',
            location: 'device',
        },
        {
            id: 'deleteAccount',
            title: t('preferences.deleteAccount'),
            description: t('preferences.deleteAccountConfirm'),
            icon: 'delete-forever',
            location: 'server',
            onPress: () => openModal('deleteAccount'),
        },
    ];

    const renderLocationChip = (location: DataLocation) => {
        const isServer = location === 'server';
        return (
            <Box
                className={`ml-2 px-2 py-0.5 rounded-full border ${
                    isServer
                        ? 'bg-amber-950 border-amber-700'
                        : 'bg-green-950 border-green-800'
                }`}
            >
                <Text
                    size="2xs"
                    className={isServer ? 'text-amber-300' : 'text-green-300'}
                >
                    {t(isServer ? 'manageData.locationServer' : 'manageData.locationDevice')}
                </Text>
            </Box>
        );
    };

    const renderOption = (
        option: OptionEntry | AccountEntry,
    ) => {
        const isAccount = option.id === 'deleteAccount';
        return (
            <Pressable
                key={option.id}
                className="flex-row items-center py-4 px-4 border border-gray-700 rounded-lg"
                onPress={
                    isAccount
                        ? (option as AccountEntry).onPress
                        : () => setConfirmAction((option as OptionEntry).id)
                }
                disabled={isProcessing || isDeletingAccount}
            >
                <Box className="flex-row items-center flex-1">
                    <MaterialIcons name={option.icon} size={22} color="#ef4444" />
                    <VStack className="ml-3 flex-1">
                        <Box className="flex-row items-center">
                            <Text className="text-base text-red-400">{option.title}</Text>
                            {renderLocationChip(option.location)}
                        </Box>
                        <Text size="xs" className="text-gray-500">{option.description}</Text>
                    </VStack>
                </Box>
            </Pressable>
        );
    };

    const activeOption = confirmAction
        ? options.find((o) => o.id === confirmAction)
        : null;

    return (
        <GluestackUIProvider mode="dark">
            <Box className="flex-1 bg-black">
                {onBack && (
                    <Box style={{ position: 'absolute', top: insets.top + 16, left: 16, zIndex: 20 }}>
                        <Pressable
                            onPress={onBack}
                            className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                        >
                            <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                        </Pressable>
                    </Box>
                )}

                <VStack className="px-5 pb-5" style={{ paddingTop: insets.top + 16 }}>
                    <Text className="text-xl font-semibold text-white text-center">{t('manageData.title')}</Text>
                </VStack>

                <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
                    <Text size="sm" className="text-gray-400 mb-5">
                        {t('manageData.description')}
                    </Text>

                    <VStack space="md">
                        {options.map(renderOption)}
                    </VStack>
                </ScrollView>

                {/* Generic confirmation modal — covers every option except delete-account, which has its own two-step flow. */}
                {confirmAction && activeOption && activeOption.id !== 'deleteAccount' && (
                    <Modal isOpen={!!confirmAction} onClose={() => setConfirmAction(null)} size="sm">
                        <ModalBackdrop />
                        <ModalContent>
                            <ModalHeader className="border-gray-700 pb-4">
                                <Text className="text-xl font-semibold text-red-400">
                                    {activeOption.title}
                                </Text>
                            </ModalHeader>
                            <ModalBody className="py-6">
                                <Text className="text-gray-300 text-base leading-relaxed">
                                    {(activeOption as OptionEntry).modalDescription}
                                </Text>
                            </ModalBody>
                            <ModalFooter className="border-t border-gray-700 pt-4">
                                <VStack className="w-full" space="md">
                                    <Button
                                        action="negative"
                                        onPress={handleConfirm}
                                        disabled={isProcessing}
                                        className="w-full"
                                    >
                                        <ButtonText>
                                            {isProcessing ? t('manageData.deleting') : t('common.delete')}
                                        </ButtonText>
                                    </Button>
                                    <Button
                                        variant="outline"
                                        action="secondary"
                                        onPress={() => setConfirmAction(null)}
                                        className="w-full"
                                    >
                                        <ButtonText>{t('common.cancel')}</ButtonText>
                                    </Button>
                                </VStack>
                            </ModalFooter>
                        </ModalContent>
                    </Modal>
                )}

                {/* Delete Account First Confirmation Modal */}
                <Modal isOpen={showDeleteInitial} onClose={() => closeModal('deleteAccount')} size="sm">
                    <ModalBackdrop />
                    <ModalContent>
                        <ModalHeader className="border-gray-700 pb-4">
                            <Text className="text-xl font-semibold text-red-400">{t('preferences.deleteAccount')}</Text>
                        </ModalHeader>
                        <ModalBody className="py-6">
                            <Text className="text-gray-300 text-base leading-relaxed mb-4">
                                {t('preferences.deleteAccountConfirm')}
                            </Text>
                            <Text className="text-red-400 text-sm font-medium">
                                {t('preferences.deleteAccountWarning')}
                            </Text>
                        </ModalBody>
                        <ModalFooter className="border-t border-gray-700 pt-4">
                            <VStack className="w-full" space="md">
                                <Button
                                    action="negative"
                                    onPress={() => setDeleteAccountStep('confirm')}
                                    className="w-full"
                                >
                                    <ButtonText>{t('preferences.continue')}</ButtonText>
                                </Button>
                                <Button
                                    variant="outline"
                                    action="secondary"
                                    onPress={() => closeModal('deleteAccount')}
                                    className="w-full"
                                >
                                    <ButtonText>{t('common.cancel')}</ButtonText>
                                </Button>
                            </VStack>
                        </ModalFooter>
                    </ModalContent>
                </Modal>

                {/* Delete Account Final Confirmation Modal */}
                <Modal isOpen={showDeleteConfirm} onClose={() => closeModal('deleteAccount')} size="sm">
                    <ModalBackdrop />
                    <ModalContent className="bg-gray-900 border border-gray-700">
                        <ModalHeader className="border-gray-700 pb-4">
                            <Text className="text-xl font-semibold text-red-400">{t('preferences.finalConfirmation')}</Text>
                        </ModalHeader>
                        <ModalBody className="py-6">
                            <Text className="text-gray-300 text-base leading-relaxed mb-4">
                                {t('preferences.finalConfirmationBody')}
                            </Text>
                            <Text className="text-red-400 text-base font-semibold">
                                {t('preferences.absolutelySure')}
                            </Text>
                        </ModalBody>
                        <ModalFooter className="border-t border-gray-700 pt-4">
                            <VStack className="w-full" space="md">
                                <Button
                                    action="negative"
                                    onPress={handleDeleteAccount}
                                    disabled={isDeletingAccount}
                                    className="w-full"
                                >
                                    <ButtonText>
                                        {isDeletingAccount ? t('preferences.deleting') : t('preferences.yesDeleteAccount')}
                                    </ButtonText>
                                </Button>
                                <Button
                                    variant="outline"
                                    action="secondary"
                                    onPress={() => closeModal('deleteAccount')}
                                    className="w-full"
                                >
                                    <ButtonText>{t('common.cancel')}</ButtonText>
                                </Button>
                            </VStack>
                        </ModalFooter>
                    </ModalContent>
                </Modal>
            </Box>
        </GluestackUIProvider>
    );
};

export default ManageDataScreen;
