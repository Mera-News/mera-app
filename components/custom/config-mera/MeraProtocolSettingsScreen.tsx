import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Progress, ProgressFilledTrack } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { BUILT_IN_MODEL_NAME } from '@/lib/mera-protocol-toolkit/core/downloadService';
import {
    averageMs,
    hasAnyStat,
    totalLoadMs,
} from '@/lib/mera-protocol-toolkit/core/inference-stats';
import { Switch } from '@/components/ui/switch';
import { AttestationVerificationRow } from '@/components/custom/config-mera/AttestationVerificationRow';
import { onDeviceSubtitleKind } from '@/components/custom/config-mera/on-device-subtitle';
import BetaBadge from '@/components/custom/BetaBadge';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useRef } from 'react';
import {
    AccessibilityInfo,
    findNodeHandle,
    type LayoutChangeEvent,
    Linking,
    Platform,
    ScrollView,
    StyleSheet,
    View,
} from 'react-native';
import { protocolFocusPlan } from './protocol-focus';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Group, GroupLabel, Help, Row } from '@/components/custom/you/rows';
import { tint, useColors } from '@/lib/theme/tokens';
import {
    BG_REFRESH_TITLE_KEY,
    bgRefreshDescriptionKey,
} from '@/lib/background/bg-refresh-ui';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { gbText, useMeraProtocolSettings, type ModelRowState, type TextOption } from './useMeraProtocolSettings';
import { isBuiltInEngine } from '@/lib/mera-protocol-toolkit/core/text-engine';

/** Both downloadable models are Apache 2.0 (one ships no LICENSE file), so each row links the licence text. */
const MODELS_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';

const secondsText = (ms: number): string => (ms / 1000).toFixed(1);

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
        showRequirements,
        setShowRequirements,
        isDeletingModel,
        processingMode,
        isOnDevice,
        store,
        webSearchInChat,
        inferenceStats,
        deviceSupported,
        onDeviceIntent,
        bgRefreshEnabled,
        toggleBgRefresh,
        onDeviceNotes,
        toggleNotes,
        selectMode,
        refresh,
        runnable,
        waitingLine,
        relevanceModel,
        textOptions,
        textEngine,
        selectEngine,
        handleDownload,
        handleCancelDownload,
        handleDeleteModel,
    } = useMeraProtocolSettings();
    const insets = useSafeAreaInsets();

    // Apple Intelligence can be switched on while the app runs: ask again on every focus.
    useFocusEffect(
        useCallback(() => {
            void refresh();
        }, [refresh]),
    );

    // `?focus=on-device` (the reading meter's "on this phone" link): once per
    // mount, scroll the On this phone row into view and give it screen-reader focus.
    const { focus } = useLocalSearchParams<{ focus?: string }>();
    const scrollRef = useRef<ScrollView>(null);
    // Two layout events feed protocolFocusPlan: the section's y within the scroll
    // content, and the row's native tag from the row's OWN layout event (the kit
    // Pressable's ref is not a native component, so it cannot be measured).
    const focusState = useRef<{ done: boolean; sectionY: number | null; rowTag: number | null }>({
        done: false,
        sectionY: null,
        rowTag: null,
    });
    const tryFocusOnDeviceRow = () => {
        const plan = protocolFocusPlan({ focus, ...focusState.current });
        if (!plan || !scrollRef.current) return;
        focusState.current.done = true;
        scrollRef.current.scrollTo({ y: plan.scrollY, animated: false });
        AccessibilityInfo.setAccessibilityFocus(plan.tag);
    };
    const onSectionLayout = (e: LayoutChangeEvent) => {
        focusState.current.sectionY = e.nativeEvent.layout.y;
        tryFocusOnDeviceRow();
    };
    const onDeviceRowLayout = (e: LayoutChangeEvent) => {
        // The event's currentTarget is the row's native host; nativeEvent.target is its tag.
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
        tryFocusOnDeviceRow();
    };

    // "Where Mera reads your news" (FinalSettings #11): On this phone is
    // always shown, for transparency, and disabled with the reason when the
    // phone can't run it; Private cloud says what it is. On this phone carries
    // the red Beta subtext, like every on-device row (D30).
    const modeRow = (mode: ProcessingMode) => {
        const onDevice = mode === ProcessingMode.OnDevice;
        const selected = onDevice ? onDeviceIntent : !onDeviceIntent;
        const cantRun = onDevice && deviceSupported === false;
        const title = onDevice ? t('you.settings.onThisPhone') : t('you.settings.privateCloud');
        const subtitle = onDevice
            ? (onDeviceSubtitleKind(cantRun) === 'cantRun' ? t('meraProtocol.cantRun') : t('meraProtocol.onDeviceNeedsCloud'))
            : t('meraProtocol.encrypted');
        return (
            <Pressable
                key={mode}
                onLayout={onDevice ? onDeviceRowLayout : undefined}
                testID={onDevice ? 'mode-on-device' : 'mode-cloud'}
                onPress={() => selectMode(mode)}
                disabled={isUpdatingMode || isDeletingModel || cantRun}
                accessibilityRole="radio"
                accessibilityState={{ selected, checked: selected, disabled: isUpdatingMode || isDeletingModel || cantRun }}
                accessibilityLabel={[title, onDevice ? t('common.beta') : null, subtitle].filter(Boolean).join(', ')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 16, opacity: cantRun ? 0.45 : 1 }}
            >
                <MaterialIcons name={selected ? 'radio-button-checked' : 'radio-button-unchecked'} size={22} color={selected ? colors.accent : colors.ink3} />
                <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.ink, fontSize: 16 }}>{title}</Text>
                    {onDevice ? <BetaBadge variant="subtext" testID="mode-on-device-beta" /> : null}
                    {subtitle ? <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{subtitle}</Text> : null}
                </View>
            </Pressable>
        );
    };

    // A downloadable model's state line, under its title: queued, downloading, failed, on disk, or its size.
    const modelStatusLine = (m: ModelRowState): { text: string; negative: boolean } => {
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
        if (m.onDisk) return { text: t('meraProtocol.modelReady'), negative: false };
        if (m.storageShort) return { text: t('meraProtocol.freeUpToDownload', { size: m.freeUpSize }), negative: true };
        return { text: `${gbText(m.sizeBytes)} GB`, negative: false };
    };

    // A downloadable model's controls, below its row: Download, progress and Cancel, Try again, or the
    // trash once it is on disk, then its licence link. Siblings of the row, never inside it: a button
    // nested in a row steals the row's accessibility activation.
    const modelControls = (m: ModelRowState, name: string) => {
        const d = m.download;
        const size = `${gbText(m.sizeBytes)} GB`;
        const busy = d?.status === 'queued' || d?.status === 'downloading';
        return (
            <VStack space="sm" className="mt-2" testID={`model-controls-${m.modelId}`}>
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
                            <MaterialIcons name="close" size={18} color={colors.negative} style={{ marginRight: 8 }} />
                            <ButtonText className="text-negative">{t('meraProtocol.cancelDownloadAction')}</ButtonText>
                        </Button>
                    </>
                ) : !m.onDisk ? (
                    <Button
                        action="primary"
                        variant="solid"
                        size="md"
                        onPress={() => { void handleDownload(m.modelId); }}
                        isDisabled={m.storageShort || isDeletingModel}
                        testID={`model-download-${m.modelId}`}
                        accessibilityLabel={d?.status === 'failed' ? t('meraProtocol.tryAgain') : t('meraProtocol.downloadAction', { size })}
                    >
                        <MaterialIcons name={d?.status === 'failed' ? 'refresh' : 'cloud-download'} size={18} color={colors.ink} style={{ marginRight: 8 }} />
                        <ButtonText>{d?.status === 'failed' ? t('meraProtocol.tryAgain') : t('meraProtocol.downloadAction', { size })}</ButtonText>
                    </Button>
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Pressable
                        testID={`model-license-${m.modelId}`}
                        onPress={() => { void Linking.openURL(MODELS_LICENSE_URL); }}
                        accessibilityRole="link"
                        style={{ flex: 1, minHeight: 44, justifyContent: 'center', marginHorizontal: 4 }}
                    >
                        <Text size="xs" className="text-ink-3 underline">
                            {t('meraProtocol.modelLicenseLink')}
                        </Text>
                    </Pressable>
                    {m.onDisk && !busy ? (
                        <View style={{ width: 44, height: 44 }}>
                            {/* The visual is hidden and the labelled Pressable has no children,
                                so a screen reader never reads the icon font's glyph. */}
                            <View
                                pointerEvents="none"
                                accessibilityElementsHidden
                                importantForAccessibility="no-hide-descendants"
                                style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
                            >
                                <MaterialIcons name="delete-outline" size={22} color={colors.negative} />
                            </View>
                            <Pressable
                                testID={`model-delete-${m.modelId}`}
                                onPress={() => { void handleDeleteModel(m.modelId); }}
                                disabled={isDeletingModel}
                                accessibilityRole="button"
                                accessibilityState={{ disabled: isDeletingModel }}
                                accessibilityLabel={t('meraProtocol.deleteModelLabel', { name })}
                                style={StyleSheet.absoluteFill}
                            />
                        </View>
                    ) : null}
                </View>
            </VStack>
        );
    };

    // The row itself: one accessible element (title, Beta, state) with a check once on disk.
    const modelRowBody = (m: ModelRowState, name: string) => {
        const line = modelStatusLine(m);
        return (
            <View
                testID={`model-row-${m.modelId}`}
                accessible
                accessibilityLabel={[
                    t(m.onDisk ? 'meraProtocol.modelRowReady' : 'meraProtocol.modelRowMissing', { name, size: `${gbText(m.sizeBytes)} GB` }),
                    t('common.beta'),
                    m.onDisk ? null : line.text,
                ].filter(Boolean).join(', ')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 16 }}
            >
                <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.ink, fontSize: 16 }}>{name}</Text>
                    {m.beta ? <BetaBadge variant="subtext" /> : null}
                    <Text style={{ color: line.negative ? colors.negative : colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{line.text}</Text>
                </View>
                {m.onDisk ? (
                    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 20, alignItems: 'center' }}>
                        <MaterialIcons name="check" size={20} color={colors.positive} />
                    </View>
                ) : null}
            </View>
        );
    };

    // One Text model radio, ONE accessible element (a disabled row's label carries its reason).
    // The Mera text model's row also carries its own download.
    const textOptionRow = (o: TextOption) => {
        const line = o.model ? modelStatusLine(o.model) : null;
        const sub = o.reason ?? line?.text ?? null;
        return (
            <View key={o.engine}>
                <Pressable
                    testID={`text-option-${o.engine}`}
                    onPress={() => { void selectEngine(o.engine); }}
                    disabled={o.disabled}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: o.selected, checked: o.selected, disabled: o.disabled }}
                    accessibilityLabel={[o.title, o.beta ? t('common.beta') : null, sub].filter(Boolean).join(', ')}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 16, opacity: o.disabled && !o.model ? 0.45 : 1 }}
                >
                    <MaterialIcons
                        name={o.selected ? 'radio-button-checked' : 'radio-button-unchecked'}
                        size={22}
                        color={o.selected ? colors.accent : colors.ink3}
                        style={{ opacity: o.disabled && o.model ? 0.45 : 1 }}
                    />
                    <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.ink, fontSize: 16 }}>{o.title}</Text>
                        {o.beta ? <BetaBadge variant="subtext" /> : null}
                        {sub ? (
                            <Text style={{ color: line?.negative ? colors.negative : colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{sub}</Text>
                        ) : null}
                    </View>
                    {o.model?.onDisk ? (
                        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 20, alignItems: 'center' }}>
                            <MaterialIcons name="check" size={20} color={colors.positive} />
                        </View>
                    ) : null}
                </Pressable>
                {o.model ? <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>{modelControls(o.model, o.title)}</View> : null}
            </View>
        );
    };

    const showModels = onDeviceIntent && deviceSupported === true;
    const refusedBy = isBuiltInEngine(textEngine) ? BUILT_IN_MODEL_NAME[textEngine] : null;

    const renderContent = () => (
        <>
            <View onLayout={onSectionLayout} style={{ paddingHorizontal: 14, marginBottom: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                        <GroupLabel>{t('meraProtocol.whereReads')}</GroupLabel>
                    </View>
                    {isUpdatingMode ? <Spinner size="small" /> : null}
                </View>
                <Group>
                    {modeRow(ProcessingMode.OnDevice)}
                    {modeRow(ProcessingMode.Cloud)}
                </Group>
                <View style={{ marginTop: 8 }}>
                    <Help>{deviceSupported === false ? t('meraProtocol.explainerCant') : `${t('meraProtocol.explainerCan')} ${t('meraProtocol.explainerOnPhoneLimits')}`}</Help>
                </View>
            </View>

            {/* Mera relevance model: always needed on this phone. Only relevant when the reader
                wants on-device AND the phone can run it; otherwise it is detail. */}
            {showModels && (
                <View style={{ paddingHorizontal: 14, marginBottom: 20 }} testID="mera-protocol-relevance">
                    <GroupLabel>{t('meraProtocol.relevanceTitle')}</GroupLabel>
                    <View style={{ marginBottom: 8 }}>
                        <Help>
                            {waitingLine ?? (runnable ? t('meraProtocol.relevanceHelp') : `${t('meraProtocol.relevanceHelp')} ${t('meraProtocol.modelsHelp')}`)}
                        </Help>
                    </View>
                    <Group>{modelRowBody(relevanceModel, t('meraProtocol.relevanceTitle'))}</Group>
                    {modelControls(relevanceModel, t('meraProtocol.relevanceTitle'))}
                </View>
            )}

            {/* Text model: which model writes chat replies, notes and topics. A built-in model
                shows only on its own platform and never needs a download. */}
            {showModels && (
                <View style={{ paddingHorizontal: 14, marginBottom: 20 }} testID="mera-protocol-text-model">
                    <GroupLabel>{t('meraProtocol.textTitle')}</GroupLabel>
                    <View style={{ marginBottom: 8 }}>
                        <Help>{t('meraProtocol.textHelp')}</Help>
                    </View>
                    <Group>{textOptions.map(textOptionRow)}</Group>
                    <View style={{ marginTop: 12 }}>
                        <Group>
                            <Row
                                title={t('meraProtocol.notesTitle')}
                                subtitle={t('meraProtocol.notesHelp')}
                                trailing={
                                    <Switch
                                        value={onDeviceNotes}
                                        onToggle={toggleNotes}
                                        size="md"
                                        testID="mera-protocol-notes-switch"
                                    />
                                }
                            />
                        </Group>
                    </View>
                </View>
            )}

            {/* Speed on this device: in memory only, never stored or sent. */}
            {showModels && hasAnyStat(inferenceStats) && (
                <VStack space="xs" className="mb-5 px-[14px]" testID="mera-protocol-speed">
                    <GroupLabel>{t('meraProtocol.speedTitle')}</GroupLabel>
                    {totalLoadMs(inferenceStats) != null && (
                        <Text size="xs" className="text-ink-2">
                            {t('meraProtocol.speedLoad', { seconds: secondsText(totalLoadMs(inferenceStats) ?? 0) })}
                        </Text>
                    )}
                    {!isBuiltInEngine(textEngine) && inferenceStats.genTokPerSec != null && (
                        <Text size="xs" className="text-ink-2">
                            {t('meraProtocol.speedGeneration', { tokPerSec: inferenceStats.genTokPerSec })}
                        </Text>
                    )}
                    {averageMs(inferenceStats.relevance) != null && (
                        <Text size="xs" className="text-ink-2">
                            {t('meraProtocol.speedRanking', { seconds: secondsText(averageMs(inferenceStats.relevance) ?? 0) })}
                        </Text>
                    )}
                    {averageMs(inferenceStats.reason) != null && (
                        <Text size="xs" className="text-ink-2">
                            {t('meraProtocol.speedNotes', { seconds: secondsText(averageMs(inferenceStats.reason) ?? 0) })}
                        </Text>
                    )}
                    {refusedBy && inferenceStats.refused > 0 && (
                        <Text size="xs" className="text-ink-2">
                            {t('meraProtocol.speedRefused', { name: refusedBy, count: inferenceStats.refused })}
                        </Text>
                    )}
                    <Text size="xs" className="text-ink-3">
                        {t('meraProtocol.speedResetNote')}
                    </Text>
                </VStack>
            )}

            {/* Background refresh. The copy follows the mode the run will
                actually use. */}
            <View style={{ paddingHorizontal: 14, marginBottom: 6 }} testID="mera-protocol-bg-refresh">
                <GroupLabel>{t('meraProtocol.whileClosed')}</GroupLabel>
                <Group>
                    <Row
                        title={t(BG_REFRESH_TITLE_KEY)}
                        subtitle={t(bgRefreshDescriptionKey(processingMode === ProcessingMode.OnDevice, Platform.OS))}
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

            {/* Web search in chat (item 13) — ON by default since the
                web-search wave, and forced on once for every existing device
                (see mera-protocol-store's SETTING_WEB_SEARCH_FORCED_ON). The
                description states plainly that the query leaves the device, in
                the toggle itself rather than buried in the privacy block below:
                this is the one setting on this screen that sends anything to a
                third party, so the disclosure has to be where the switch is —
                and now that it is on by default, that disclosure is the only
                thing standing between the user and a surprise.

                It was also the one switch never gated by the free-tier
                read-only flag, because turning a privacy setting OFF must never
                sit behind a paywall. That flag is gone now, so the exception
                has nothing left to be an exception to. */}
            <View style={{ paddingHorizontal: 14, marginBottom: 20 }} testID="mera-protocol-web-search">
                <GroupLabel>{t('meraProtocol.chatGroup')}</GroupLabel>
                <Group>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 10, paddingHorizontal: 16 }}>
                        <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Text style={{ color: colors.ink, fontSize: 16 }}>{t('meraProtocol.webSearchTitle')}</Text>
                                <BetaBadge />
                            </View>
                            <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{t('meraProtocol.webSearchShort')}</Text>
                        </View>
                        <Switch
                            value={webSearchInChat}
                            onToggle={() => store.setWebSearchInChat(!webSearchInChat)}
                            size="md"
                            testID="mera-protocol-web-search-switch"
                        />
                    </View>
                </Group>
            </View>

            {/* Privacy Explainer */}
            {/* Privacy shows in green (FinalSettings #11). */}
            <View style={{ marginHorizontal: 14, marginBottom: 20, borderRadius: 16, padding: 16, gap: 4, overflow: 'hidden' }} testID="mera-protocol-private">
                <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.positive, opacity: 0.12 }]} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <MaterialIcons name="verified-user" size={18} color={colors.positive} />
                    <Text style={{ color: colors.positive, fontSize: 16, fontWeight: '600' }}>{t('meraProtocol.staysPrivateTitle')}</Text>
                </View>
                <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{t('meraProtocol.staysPrivateBody')}</Text>
            </View>

            {/* Verify attestation — UNCONDITIONAL. This sits with the privacy
                explainer rather than under the on-device section because it is
                Cloud mode (the default) where attestation is what stands
                between the user's prompts and the operator. Hiding it behind a
                mode toggle would hide it from everyone it protects. */}
            <AttestationVerificationRow />

            {/* Device Capability Notice — only when the user has expressed intent
                to run on-device on a device that can't support it. Cloud-mode
                users (the default) never see this; Mera Protocol works fine for
                them via the Cloud TEE LLM regardless of device specs. */}
            {onDeviceIntent && requirementsResult && deviceSupported === false && (
                <Box className="px-5 mb-6">
                    <Box className="p-4 rounded-lg border bg-surface border-negative">
                        <Pressable onPress={() => setShowRequirements(prev => !prev)}>
                            <HStack space="md" className="items-start">
                                <MaterialIcons
                                    name="warning"
                                    size={24}
                                    color={colors.negative}
                                    style={{ marginTop: 2 }}
                                />
                                <VStack className="flex-1">
                                    <Text className="text-base font-semibold mb-1 text-negative">
                                        {t('meraProtocol.deviceNotSupported')}
                                    </Text>
                                    <Text className="text-sm text-negative">
                                        {t('meraProtocol.deviceNotSupportedDescription')}
                                    </Text>
                                </VStack>
                                <MaterialIcons
                                    name={showRequirements ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
                                    size={24}
                                    color={colors.negative}
                                    style={{ marginTop: 2 }}
                                />
                            </HStack>
                        </Pressable>

                        {/* System Requirements (accordion) */}
                        {showRequirements && (
                            <VStack space="sm" className="mt-4 pt-4 border-t" style={{ borderTopColor: tint(colors.negative, 0.4) }}>
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons
                                        name={requirementsResult.failedCheck === 'ram' ? 'cancel' : 'check-circle'}
                                        size={16}
                                        color={requirementsResult.failedCheck === 'ram' ? colors.negative : colors.positive}
                                    />
                                    <Text className="text-ink-2 text-sm">
                                        {t('meraProtocol.ramLabel')}{requirementsResult.deviceInfo.ramGB != null ? ` (yours: ${requirementsResult.deviceInfo.ramGB}GB)` : ''}
                                    </Text>
                                </HStack>
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons
                                        name={requirementsResult.failedCheck === 'os_version' ? 'cancel' : 'check-circle'}
                                        size={16}
                                        color={requirementsResult.failedCheck === 'os_version' ? colors.negative : colors.positive}
                                    />
                                    <Text className="text-ink-2 text-sm">
                                        {Platform.OS === 'ios' ? t('meraProtocol.iosVersion') : t('meraProtocol.androidVersion')}{requirementsResult.deviceInfo.osVersion ? ` (yours: ${requirementsResult.deviceInfo.osVersion})` : ''}
                                    </Text>
                                </HStack>
                                {Platform.OS === 'ios' && (
                                    <HStack space="sm" className="items-center">
                                        <MaterialIcons
                                            name={requirementsResult.failedCheck === 'chip' ? 'cancel' : 'check-circle'}
                                            size={16}
                                            color={requirementsResult.failedCheck === 'chip' ? colors.negative : colors.positive}
                                        />
                                        <Text className="text-ink-2 text-sm">{t('meraProtocol.chipLabel')}</Text>
                                    </HStack>
                                )}
                            </VStack>
                        )}
                    </Box>
                </Box>
            )}

        </>
    );

    // Loading state
    if (isLoading) {
        return (
            <GluestackUIProvider>
                <Box className="flex-1">
                    {/* Page background. Must be the FIRST child so it paints behind
                        everything else on the page. */}
                    <AbstractGradientBackdrop />

                    <Box style={{ paddingTop: insets.top }}>
                        <DrillDownHeader title={t('meraProtocol.title')} onBack={onBack} />
                    </Box>
                    <VStack className="flex-1 justify-center items-center">
                        <Spinner size="large" />
                    </VStack>
                </Box>
            </GluestackUIProvider>
        );
    }

    // Preferences mode
    // Keep `isOnDevice` referenced so eslint doesn't strip the selector.
    void isOnDevice;

    return (
        <GluestackUIProvider>
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Box style={{ paddingTop: insets.top }}>
                    <DrillDownHeader title={t('meraProtocol.title')} onBack={onBack} />
                </Box>

                <ScrollView ref={scrollRef} className="flex-1" contentContainerStyle={{ paddingBottom: endClearance }}>
                    {renderContent()}
                </ScrollView>

            </Box>
        </GluestackUIProvider>
    );
};

export default MeraProtocolSettingsScreen;
