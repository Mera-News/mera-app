import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HelpModal } from '@/components/ui/help-modal';
import { Pressable } from '@/components/ui/pressable';
import { Progress, ProgressFilledTrack } from '@/components/ui/progress';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { StepsAccordion, type AccordionStep } from '@/components/ui/steps-accordion';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { BUILT_IN_MODEL_NAME } from '@/lib/mera-protocol-toolkit/core/downloadService';
import { averageMs, hasAnyStat } from '@/lib/mera-protocol-toolkit/core/inference-stats';
import { AttestationVerificationRow } from '@/components/custom/config-mera/AttestationVerificationRow';
import BetaBadge from '@/components/custom/BetaBadge';
import HelpButton from '@/components/custom/nav/HelpButton';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    findNodeHandle,
    type LayoutChangeEvent,
    Linking,
    Platform,
    ScrollView,
    View,
} from 'react-native';
import { protocolFocusPlan } from './protocol-focus';
import { onDeviceSteps } from './on-device-steps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Group, GroupLabel, Help, Row } from '@/components/custom/you/rows';
import { useColors } from '@/lib/theme/tokens';
import {
    BG_REFRESH_TITLE_KEY,
    bgRefreshDescriptionKey,
} from '@/lib/background/bg-refresh-ui';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { gbText, useMeraProtocolSettings, type ModelRowState } from './useMeraProtocolSettings';

/** The downloadable model is Apache 2.0 (it ships no LICENSE file), so the tab links the licence text. */
const MODELS_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';

const secondsText = (ms: number): string => (ms / 1000).toFixed(1);

/** An icon font's glyph is never read aloud: its accessible parent carries the words. */
const HIDDEN = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

/** What a "?" on this page explains (invariant 20: a HelpModal, never a sheet). */
type HelpTopic = 'modes' | 'cantRun' | 'webSearch' | 'cloudChat' | 'reasons' | 'bgRefresh';

/** The order checkRequirements runs its checks in: it stops at the first that fails. */
const CHECK_ORDER = ['ram', 'os_version', 'chip', 'built_in'] as const;

interface MeraProtocolSettingsScreenProps {
    onBack?: () => void;
}

const MeraProtocolSettingsScreen: React.FC<MeraProtocolSettingsScreenProps> = ({
    onBack,
}) => {
    const endClearance = useListEndClearance();
    const { t } = useTranslation();
    const colors = useColors();
    const {
        isLoading,
        isUpdatingMode,
        requirementsResult,
        isDeletingModel,
        processingMode,
        store,
        webSearchInChat,
        inferenceStats,
        deviceSupported,
        onDeviceIntent,
        bgRefreshEnabled,
        toggleBgRefresh,
        skipNotes,
        toggleSkipNotes,
        chatInCloud,
        toggleChatInCloud,
        selectMode,
        refresh,
        runnable,
        waitingLine,
        relevanceModel,
        builtInStatus,
        builtInName,
        handleDownload,
        handleCancelDownload,
        handleDeleteModel,
    } = useMeraProtocolSettings();
    const insets = useSafeAreaInsets();
    // The topic stays set while the card fades out, so its text never blanks mid-close.
    const [help, setHelp] = useState<{ topic: HelpTopic; open: boolean } | null>(null);
    const openHelp = (topic: HelpTopic) => setHelp({ topic, open: true });

    // Apple Intelligence can be switched on while the app runs: ask again on every focus.
    useFocusEffect(
        useCallback(() => {
            void refresh();
        }, [refresh]),
    );

    // `?focus=on-device` (the reading meter's "Read on this phone" link): once per mount,
    // open the On this phone tab, scroll the tabs into view and give their heading
    // screen-reader focus. Until the phone can run it, the pick only records the intent.
    const { focus } = useLocalSearchParams<{ focus?: string }>();
    const pickedRef = useRef(false);
    useEffect(() => {
        if (isLoading || focus !== 'on-device' || pickedRef.current) return;
        pickedRef.current = true;
        if (!onDeviceIntent) void selectMode(ProcessingMode.OnDevice);
        // Once, when the load lands: selectMode is a fresh closure every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoading]);
    const scrollRef = useRef<ScrollView>(null);
    const focusState = useRef<{ done: boolean; sectionY: number | null; rowTag: number | null }>({
        done: false,
        sectionY: null,
        rowTag: null,
    });
    const tryFocusModes = () => {
        const plan = protocolFocusPlan({ focus, ...focusState.current });
        if (!plan || !scrollRef.current) return;
        focusState.current.done = true;
        scrollRef.current.scrollTo({ y: plan.scrollY, animated: false });
        AccessibilityInfo.setAccessibilityFocus(plan.tag);
    };
    const onSectionLayout = (e: LayoutChangeEvent) => {
        focusState.current.sectionY = e.nativeEvent.layout.y;
        tryFocusModes();
    };
    const onModesHeadLayout = (e: LayoutChangeEvent) => {
        // The event's currentTarget is the heading's native host; nativeEvent.target is its tag.
        let tag: number | null = null;
        try {
            tag = findNodeHandle(e.currentTarget as never);
        } catch {
            tag = null;
        }
        if (tag == null) {
            const target = (e.nativeEvent as { target?: unknown }).target;
            tag = typeof target === 'number' ? target : null;
        }
        focusState.current.rowTag = tag;
        tryFocusModes();
    };

    /** A group label with its "?" on the trailing side. The 44pt frame overhangs, so the label keeps its rhythm. */
    const sectionHead = (label: string, topic: HelpTopic, onLayout?: (e: LayoutChangeEvent) => void, trailing?: React.ReactNode) => (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
            <View
                style={{ flex: 1 }}
                onLayout={onLayout}
                accessible={onLayout ? true : undefined}
                accessibilityRole={onLayout ? 'header' : undefined}
                accessibilityLabel={onLayout ? label : undefined}
            >
                <GroupLabel>{label}</GroupLabel>
            </View>
            {trailing}
            <HelpButton
                onPress={() => openHelp(topic)}
                label={t('meraProtocol.helpLabel', { topic: label })}
                testID={`mera-protocol-help-${topic}`}
                style={{ marginBottom: -8, marginEnd: -6 }}
            />
        </View>
    );

    // A step's progress, failure or storage line, under its title.
    const modelStatusLine = (m: ModelRowState): { text: string; negative: boolean } | null => {
        const d = m.download;
        if (d?.status === 'queued') return { text: t('meraProtocol.modelQueued'), negative: false };
        if (d?.status === 'downloading') {
            return { text: t('meraProtocol.downloadingOf', { done: gbText(d.doneBytes), total: gbText(d.totalBytes) }), negative: false };
        }
        if (d?.status === 'failed') {
            return {
                text: d.failure === 'space'
                    ? t('meraProtocol.errorSpace', { size: m.freeUpSize })
                    : t(d.failure === 'damaged' ? 'meraProtocol.errorFile' : 'meraProtocol.errorFinish'),
                negative: true,
            };
        }
        if (m.storageShort) return { text: t('meraProtocol.freeUpToDownload', { size: m.freeUpSize }), negative: true };
        return null;
    };

    // Step 1's body: Download, progress and Cancel, Try again, or why this phone can't run it.
    const modelBody = (m: ModelRowState, cantRun: boolean) => {
        const d = m.download;
        const size = `${gbText(m.sizeBytes)} GB`;
        const busy = d?.status === 'queued' || d?.status === 'downloading';
        const line = modelStatusLine(m);
        if (cantRun) {
            return (
                <View style={{ flexDirection: 'row', alignItems: 'center' }} testID="mera-protocol-cant-run">
                    <Text style={{ flex: 1, color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{t('meraProtocol.cantRun')}</Text>
                    <HelpButton
                        onPress={() => openHelp('cantRun')}
                        label={t('meraProtocol.helpLabel', { topic: t('meraProtocol.cantRunHelpTitle') })}
                        testID="mera-protocol-help-cantRun"
                        style={{ marginVertical: -10, marginEnd: -6 }}
                    />
                </View>
            );
        }
        return (
            <VStack space="sm" testID={`model-controls-${m.modelId}`}>
                {line ? (
                    <Text accessibilityLiveRegion="polite" style={{ color: line.negative ? colors.negative : colors.ink2, fontSize: 13, lineHeight: 18 }}>
                        {line.text}
                    </Text>
                ) : null}
                {busy ? (
                    <>
                        {d?.status === 'downloading' ? (
                            <Progress value={d.totalBytes > 0 ? (d.doneBytes / d.totalBytes) * 100 : 0} size="sm">
                                <ProgressFilledTrack />
                            </Progress>
                        ) : null}
                        <Button
                            action="negative"
                            variant="outline"
                            size="md"
                            onPress={() => { void handleCancelDownload(m.modelId); }}
                            accessibilityLabel={t('meraProtocol.cancelDownloadAction')}
                        >
                            <ButtonText className="text-negative">{t('meraProtocol.cancelDownloadAction')}</ButtonText>
                        </Button>
                    </>
                ) : (
                    <Button
                        action="primary"
                        variant="solid"
                        size="md"
                        onPress={() => { void handleDownload(m.modelId); }}
                        // Not before the requirement check lands: a phone that can't run it never downloads.
                        isDisabled={m.storageShort || isDeletingModel || deviceSupported !== true}
                        testID={`model-download-${m.modelId}`}
                        accessibilityLabel={d?.status === 'failed' ? t('meraProtocol.tryAgain') : t('meraProtocol.downloadAction', { size })}
                    >
                        <ButtonText>{d?.status === 'failed' ? t('meraProtocol.tryAgain') : t('meraProtocol.downloadAction', { size })}</ButtonText>
                    </Button>
                )}
            </VStack>
        );
    };

    // The built-in model's status, in step 2: name, Beta, ready or why not.
    const builtInBody = () =>
        builtInStatus ? (
            <View
                testID="built-in-model-row"
                accessible
                accessibilityLabel={[builtInStatus.name, t('common.beta'), builtInStatus.reason ?? t('meraProtocol.builtInReady')].join(', ')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
            >
                <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.ink, fontSize: 15 }}>{builtInStatus.name}</Text>
                    <BetaBadge variant="subtext" />
                    <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>
                        {builtInStatus.reason ?? t('meraProtocol.builtInReady')}
                    </Text>
                </View>
                {builtInStatus.available ? (
                    <View {...HIDDEN}>
                        <MaterialIcons name="check" size={20} color={colors.positive} />
                    </View>
                ) : null}
            </View>
        ) : null;

    const webSearchRow = () => (
        <Row
            testID="mera-protocol-web-search"
            title={t('meraProtocol.webSearchTitle')}
            subtitle={t('meraProtocol.webSearchLine')}
            trailing={
                <Switch
                    value={webSearchInChat}
                    onToggle={() => store.setWebSearchInChat(!webSearchInChat)}
                    size="md"
                    testID="mera-protocol-web-search-switch"
                />
            }
        />
    );

    const relevanceName = t('meraProtocol.relevanceTitle');
    const modelSize = `${gbText(relevanceModel.sizeBytes)} GB`;
    const steps = onDeviceSteps({
        onDisk: relevanceModel.onDisk,
        download: relevanceModel.download?.status ?? null,
        deviceSupported,
        onDevice: processingMode === ProcessingMode.OnDevice,
        chatInCloud,
    });

    // Private cloud's row for a model left on the phone: its size or progress, and Delete or Cancel.
    const keptModelRow = () => {
        const busy = relevanceModel.download?.status === 'queued' || relevanceModel.download?.status === 'downloading';
        const label = busy ? t('meraProtocol.cancelDownloadAction') : t('common.delete');
        return (
            <Row
                testID="mera-protocol-kept-model"
                title={t('meraProtocol.stepModelTitle')}
                subtitle={modelStatusLine(relevanceModel)?.text ?? modelSize}
                trailing={
                    <Pressable
                        onPress={() => {
                            if (busy) void handleCancelDownload(relevanceModel.modelId);
                            else void handleDeleteModel(relevanceModel.modelId);
                        }}
                        disabled={isDeletingModel}
                        accessibilityRole="button"
                        accessibilityLabel={`${label}, ${t('meraProtocol.stepModelTitle')}`}
                        testID="mera-protocol-kept-model-action"
                        style={{ minHeight: 44, justifyContent: 'center' }}
                    >
                        <Text style={{ color: colors.negative, fontSize: 15, fontWeight: '600' }}>{label}</Text>
                    </Pressable>
                }
            />
        );
    };

    const onDeviceAccordion = (): AccordionStep[] => [
        {
            id: 'model',
            title: t('meraProtocol.stepModelTitle'),
            hint: steps.phase === 'cantRun' ? undefined : t('meraProtocol.modelRowMissing', { name: relevanceName, size: modelSize }),
            summary: t('meraProtocol.modelRowReady', { name: relevanceName, size: modelSize }),
            status: steps.model,
            actionLabel: t('common.delete'),
            onAction: isDeletingModel ? undefined : () => { void handleDeleteModel(relevanceModel.modelId); },
            children: modelBody(relevanceModel, steps.phase === 'cantRun'),
        },
        {
            id: 'on',
            title: t('meraProtocol.stepOnTitle'),
            hint: waitingLine ?? undefined,
            summary: builtInName ? `${builtInName} · ${t('meraProtocol.builtInReady')}` : t('meraProtocol.builtInReady'),
            status: steps.on,
            children: (
                <View style={{ gap: 12 }}>
                    {builtInBody()}
                    {runnable ? (
                        <Button
                            action="primary"
                            variant="solid"
                            size="md"
                            onPress={() => { void selectMode(ProcessingMode.OnDevice); }}
                            isDisabled={isUpdatingMode}
                            testID="mera-protocol-turn-on"
                        >
                            <ButtonText>{t('meraProtocol.turnOn')}</ButtonText>
                        </Button>
                    ) : null}
                </View>
            ),
        },
        {
            id: 'chat',
            title: t('meraProtocol.stepChatTitle'),
            status: steps.chat,
            children: (
                <View style={{ gap: 8 }}>
                    <Group>
                        <Row
                            testID="mera-protocol-chat-in-cloud"
                            title={t('meraProtocol.chatInCloudTitle')}
                            trailing={
                                <Switch
                                    value={chatInCloud}
                                    onToggle={toggleChatInCloud}
                                    size="md"
                                    testID="mera-protocol-chat-in-cloud-switch"
                                />
                            }
                        />
                        {steps.cloudChat ? webSearchRow() : null}
                    </Group>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                        <View style={{ flex: 1 }}>
                            <Help>{t('meraProtocol.chatInCloudNote')}</Help>
                        </View>
                        <HelpButton
                            onPress={() => openHelp('cloudChat')}
                            label={t('meraProtocol.helpLabel', { topic: t('meraProtocol.stepChatTitle') })}
                            testID="mera-protocol-help-cloudChat"
                            style={{ marginTop: -10, marginEnd: -6 }}
                        />
                    </View>
                </View>
            ),
        },
    ];

    // Speed on this phone: in memory only, never stored or sent.
    const speed = () =>
        steps.phase === 'ready' && hasAnyStat(inferenceStats) ? (
            <VStack space="xs" className="mt-2" testID="mera-protocol-speed">
                <GroupLabel>{t('meraProtocol.speedTitle')}</GroupLabel>
                {inferenceStats.loadMs != null && (
                    <Help>{t('meraProtocol.speedLoad', { seconds: secondsText(inferenceStats.loadMs) })}</Help>
                )}
                {averageMs(inferenceStats.relevance) != null && (
                    <Help>{t('meraProtocol.speedRanking', { seconds: secondsText(averageMs(inferenceStats.relevance) ?? 0) })}</Help>
                )}
                {averageMs(inferenceStats.reason) != null && (
                    <Help>{t('meraProtocol.speedNotes', { seconds: secondsText(averageMs(inferenceStats.reason) ?? 0) })}</Help>
                )}
                {builtInName && inferenceStats.refused > 0 && (
                    <Help>{t('meraProtocol.speedRefused', { name: builtInName, count: inferenceStats.refused })}</Help>
                )}
                <Help>{t('meraProtocol.speedResetNote')}</Help>
            </VStack>
        ) : null;

    // The built-in model this platform would use, for the requirements list even when this phone has none.
    const platformBuiltInName = builtInName ?? BUILT_IN_MODEL_NAME[Platform.OS === 'android' ? 'nano' : 'afm'];

    // One requirement with this phone's own value; the mark is hidden, the words say its state.
    // The check stops at the first failure, so the ones after it were never checked.
    const requirement = (id: (typeof CHECK_ORDER)[number], label: string, value?: string | null) => {
        const text = value ? `${label}. ${t('meraProtocol.thisPhoneValue', { value })}` : label;
        const failedAt = (CHECK_ORDER as readonly string[]).indexOf(requirementsResult?.failedCheck ?? '');
        const at = CHECK_ORDER.indexOf(id);
        const met = failedAt < 0 || at < failedAt;
        const failed = at === failedAt;
        const word = t(met ? 'meraProtocol.checkMet' : failed ? 'meraProtocol.checkNotMet' : 'meraProtocol.attestationNotCheckedLabel');
        return (
            <View
                key={id}
                testID={`requirement-${id}`}
                accessible
                accessibilityLabel={`${text}, ${word}`}
                style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
            >
                <View {...HIDDEN} style={{ marginTop: 1 }}>
                    <MaterialIcons
                        name={met ? 'check-circle' : failed ? 'cancel' : 'remove'}
                        size={18}
                        color={met ? colors.positive : failed ? colors.negative : colors.ink3}
                    />
                </View>
                <Text style={{ flex: 1, color: colors.ink, fontSize: 15, lineHeight: 21 }}>{text}</Text>
            </View>
        );
    };

    const helpBody = (topic: HelpTopic): { title: string; body: React.ReactNode } => {
        const para = (text: string, key?: string) => (
            <Text key={key} style={{ color: colors.ink2, fontSize: 15, lineHeight: 22 }}>{text}</Text>
        );
        switch (topic) {
            case 'modes':
                return {
                    title: t('meraProtocol.howRuns'),
                    body: [
                        para(t('meraProtocol.helpModesCloud'), 'cloud'),
                        para(t('meraProtocol.helpModesPhone'), 'phone'),
                        para(t('meraProtocol.helpModesVerify'), 'verify'),
                    ],
                };
            case 'cantRun': {
                const info = requirementsResult?.deviceInfo;
                return {
                    title: t('meraProtocol.cantRunHelpTitle'),
                    body: [
                        para(t('meraProtocol.cantRunHelpIntro'), 'intro'),
                        requirement('ram', t('meraProtocol.ramLabel'), info?.ramGB != null ? `${info.ramGB} GB` : null),
                        requirement(
                            'os_version',
                            Platform.OS === 'ios' ? t('meraProtocol.iosVersion') : t('meraProtocol.androidVersion'),
                            info?.osVersion,
                        ),
                        Platform.OS === 'ios' ? requirement('chip', t('meraProtocol.chipLabel')) : null,
                        requirement('built_in', t('meraProtocol.builtInRequirement', { name: platformBuiltInName })),
                    ],
                };
            }
            case 'webSearch':
                return {
                    title: t('meraProtocol.webSearchTitle'),
                    body: [para(t('meraProtocol.webSearchShort'), 'how'), para(t('meraProtocol.helpWebSearchOff'), 'off')],
                };
            case 'cloudChat':
                return {
                    title: t('meraProtocol.stepChatTitle'),
                    body: [
                        para(t('meraProtocol.chatInCloudNote'), 'chat'),
                        para(t('meraProtocol.webSearchShort'), 'search'),
                        para(t('meraProtocol.helpWebSearchOff'), 'off'),
                    ],
                };
            case 'reasons':
                return { title: t('meraProtocol.notesGroup'), body: para(t('meraProtocol.skipNotesHelp')) };
            case 'bgRefresh':
                return {
                    title: t(BG_REFRESH_TITLE_KEY),
                    body: para(t(bgRefreshDescriptionKey(processingMode === ProcessingMode.OnDevice, Platform.OS))),
                };
        }
    };

    const onPhoneTab = onDeviceIntent;
    // The tab is the mode the reader wants; until On this phone can run, Mera keeps running in Private cloud.
    const runsInCloudMeanwhile = onPhoneTab && processingMode !== ProcessingMode.OnDevice;
    // Said once, while step 1 is still to do: step 2 says it for the built-in model, and a phone that can't run it never will.
    const settingUp = steps.phase === 'missing' || steps.phase === 'downloading' || steps.phase === 'failed';
    // A model kept on disk (or still downloading) after a switch to Private cloud: its row, to delete or cancel it.
    const keptModel = relevanceModel.onDisk || relevanceModel.download?.status === 'queued' || relevanceModel.download?.status === 'downloading';

    const renderContent = () => (
        <>
            <View onLayout={onSectionLayout} style={{ paddingHorizontal: 14, marginBottom: 16 }}>
                {sectionHead(t('meraProtocol.howRuns'), 'modes', onModesHeadLayout, isUpdatingMode ? <Spinner size="small" /> : null)}
                <SegmentedControl<ProcessingMode>
                    testID="mera-protocol-mode"
                    accessibilityLabel={t('meraProtocol.howRuns')}
                    value={onPhoneTab ? ProcessingMode.OnDevice : ProcessingMode.Cloud}
                    onChange={(mode) => {
                        if (isUpdatingMode || isDeletingModel) return;
                        void selectMode(mode);
                    }}
                    options={[
                        { value: ProcessingMode.Cloud, label: t('you.settings.privateCloud') },
                        { value: ProcessingMode.OnDevice, label: t('you.settings.onThisPhone') },
                    ]}
                    stretch
                />
                {runsInCloudMeanwhile && settingUp ? (
                    <View style={{ marginTop: 8 }} testID="mera-protocol-in-use-cloud">
                        <Help>{t('meraProtocol.inUseCloud')}</Help>
                    </View>
                ) : null}
            </View>

            {onPhoneTab ? (
                <View style={{ paddingHorizontal: 14, marginBottom: 8 }} testID="mera-protocol-on-device-tab">
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, marginHorizontal: 4 }}>
                        {steps.phase !== 'cantRun' ? (
                            <Text style={{ flexShrink: 1, color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{t('meraProtocol.onPhoneIntro')}</Text>
                        ) : null}
                        <BetaBadge tone="negative" testID="mera-protocol-on-device-beta" />
                    </View>
                    <StepsAccordion testID="mera-protocol-steps" steps={onDeviceAccordion()} doneLabel={t('common.done')} />
                    {steps.phase !== 'cantRun' ? (
                        <Pressable
                            testID={`model-license-${relevanceModel.modelId}`}
                            onPress={() => { void Linking.openURL(MODELS_LICENSE_URL); }}
                            accessibilityRole="link"
                            style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginHorizontal: 4 }}
                        >
                            <Text size="xs" className="text-ink-3 underline">{t('meraProtocol.modelLicenseLink')}</Text>
                        </Pressable>
                    ) : null}
                    {speed()}
                </View>
            ) : (
                <View style={{ paddingHorizontal: 14, marginBottom: 8 }} testID="mera-protocol-cloud-tab">
                    <Help>{t('meraProtocol.encrypted')}</Help>
                    {sectionHead(t('meraProtocol.chatGroup'), 'webSearch')}
                    <Group>{webSearchRow()}</Group>
                    {keptModel ? (
                        <Group style={{ marginTop: 12 }}>{keptModelRow()}</Group>
                    ) : null}
                </View>
            )}

            {/* Verify attestation: whenever chat or the feed reaches the cloud. */}
            {!onPhoneTab || runsInCloudMeanwhile || steps.cloudChat ? (
                <View style={{ marginTop: 12 }}>
                    <AttestationVerificationRow />
                </View>
            ) : null}

            {/* Common to both modes. */}
            <View style={{ paddingHorizontal: 14, marginBottom: 6 }}>
                {sectionHead(t('meraProtocol.notesGroup'), 'reasons')}
                <Group>
                    <Row
                        testID="mera-protocol-notes"
                        title={t('meraProtocol.skipNotesTitle')}
                        subtitle={t('meraProtocol.skipNotesLine')}
                        trailing={
                            <Switch
                                value={skipNotes}
                                onToggle={toggleSkipNotes}
                                size="md"
                                testID="mera-protocol-skip-notes-switch"
                            />
                        }
                    />
                </Group>
                {sectionHead(t('meraProtocol.whileClosed'), 'bgRefresh')}
                <Group>
                    <Row
                        testID="mera-protocol-bg-refresh"
                        title={t(BG_REFRESH_TITLE_KEY)}
                        subtitle={t('meraProtocol.bgRefreshLine')}
                        trailing={
                            <Switch
                                value={bgRefreshEnabled}
                                onToggle={toggleBgRefresh}
                                size="md"
                                testID="mera-protocol-bg-refresh-switch"
                            />
                        }
                    />
                </Group>
            </View>
        </>
    );

    const shownHelp = help ? helpBody(help.topic) : null;

    return (
        <GluestackUIProvider>
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Box style={{ paddingTop: insets.top }}>
                    <DrillDownHeader title={t('meraProtocol.title')} onBack={onBack} />
                </Box>

                {isLoading ? (
                    <VStack className="flex-1 justify-center items-center">
                        <Spinner size="large" />
                    </VStack>
                ) : (
                    <ScrollView ref={scrollRef} className="flex-1" contentContainerStyle={{ paddingBottom: endClearance }}>
                        {renderContent()}
                    </ScrollView>
                )}

                <HelpModal
                    open={help?.open ?? false}
                    onClose={() => setHelp((h) => (h ? { ...h, open: false } : h))}
                    title={shownHelp?.title ?? ''}
                    testID="mera-protocol-help"
                >
                    <View style={{ gap: 12 }}>{shownHelp?.body}</View>
                </HelpModal>
            </Box>
        </GluestackUIProvider>
    );
};

export default MeraProtocolSettingsScreen;
