import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
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
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, useWindowDimensions, type ListRenderItem } from 'react-native';
import { exportAndShare, type ExportFormat } from './export-and-share';
import { notifyScrollTick } from '@/lib/visibility-tick';

/** Dark-mode `--color-primary-500`. A literal because MaterialIcons takes a
 *  colour prop, not a class, and the app mounts dark-only. */
const ACCENT = '#EDA77E';
const MUTED = 'rgb(140, 140, 140)';

const TOTAL_STEPS = 3;

/** The row list is the only part of this modal that can grow without bound, so
 *  it is the only part given a ceiling. Taken from the window rather than
 *  fixed: gluestack's `lg` size constrains WIDTH only (`w-[90%]
 *  max-w-[640px]`) and sets no max height at all, so an unbounded list in the
 *  body pushes the footer, and with it the Cancel button, off a short screen. */
const LIST_MAX_FRACTION = 0.45;
const LIST_MAX_PX = 420;

/** One pickable article in step 1. The title fields are what the CARD behind
 *  the wizard renders, so a row here reads the same as the row on screen; the
 *  exported file is built by the caller and may carry a different title (see
 *  lib/saved-articles-export.ts, decision 1). */
export interface ExportWizardRow {
    id: string;
    title: string;
    titleOriginal?: string;
    language?: string;
}

interface ExportWizardModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Must be referentially stable while the wizard is open (memoize it). */
    rows: ExportWizardRow[];
    /** Serialises the chosen rows, in `rows` order. May read local data first. */
    buildContent: (
        chosenIds: string[],
        includeReason: boolean,
        format: ExportFormat,
    ) => string | Promise<string>;
    /** Raised when the export could not be handed off at all. The host owns
     *  the toast so this component stays renderable in a test without one. */
    onFailed: () => void;
    dialogTitle: string;
    /** Step 2's hint under "Include Mera's reason": which rows lack one differs
     *  per surface, so the host states it. */
    reasonHint: string;
    /** Required, no default: a defaulted testID on a reusable primitive makes
     *  two surfaces answer to the same query. `{prefix}-row-<id>`,
     *  `{prefix}-next`, and so on. */
    testIDPrefix: string;
    /** Start with every row ticked. The story export does ("export everything
     *  in this story"); the Saved tab does not. */
    initiallyAllSelected?: boolean;
    fileBaseName?: string;
}

/** A checkbox row: the glyph pair this repo uses in place of a checkbox
 *  primitive, which does not exist in `components/ui`. */
const CheckGlyph: React.FC<{ checked: boolean }> = ({ checked }) => (
    <MaterialIcons
        name={checked ? 'check-box' : 'check-box-outline-blank'}
        size={22}
        color={checked ? ACCENT : MUTED}
    />
);

/**
 * The three-step export wizard: choose articles, include Mera's reason, pick a
 * format, then the OS share sheet. Shared by the Saved tab (`SavedExportModal`)
 * and a followed story's timeline, which differ only in their rows, their
 * serialiser and their copy.
 */
const ExportWizardModal: React.FC<ExportWizardModalProps> = ({
    isOpen,
    onClose,
    rows,
    buildContent,
    onFailed,
    dialogTitle,
    reasonHint,
    testIDPrefix,
    initiallyAllSelected = false,
    fileBaseName,
}) => {
    const { t } = useTranslation();
    const { height: windowHeight } = useWindowDimensions();

    const [step, setStep] = useState(1);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [includeReason, setIncludeReason] = useState(true);
    const [sharingFormat, setSharingFormat] = useState<ExportFormat | null>(null);

    // Read through a ref so the reset below stays keyed on `isOpen` alone. With
    // `rows` in its deps, a host that re-renders while the wizard is open would
    // re-tick every row and silently undo the reader's unticks.
    const rowsRef = useRef(rows);
    rowsRef.current = rows;

    // Reset on OPEN, not on close. Resetting on close would wipe the state
    // while the modal is still animating out, and the reader would watch their
    // own selection clear itself on the way past.
    useEffect(() => {
        if (!isOpen) return;
        setStep(1);
        setSelected(
            initiallyAllSelected ? new Set(rowsRef.current.map((r) => r.id)) : new Set(),
        );
        setIncludeReason(true);
        setSharingFormat(null);
    }, [isOpen, initiallyAllSelected]);

    const allSelected = rows.length > 0 && selected.size === rows.length;

    const toggleAll = useCallback(() => {
        setSelected((prev) =>
            prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)),
        );
    }, [rows]);

    const toggleOne = useCallback((id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const chosenIds = useMemo(
        () => rows.filter((r) => selected.has(r.id)).map((r) => r.id),
        [rows, selected],
    );

    const handleShare = useCallback(
        async (format: ExportFormat) => {
            if (sharingFormat) return;
            setSharingFormat(format);
            try {
                const content = await buildContent(chosenIds, includeReason, format);

                const result = await exportAndShare({
                    content,
                    format,
                    dialogTitle,
                    fileBaseName,
                });

                if (result.status === 'failed') {
                    logger.captureException(result.error, {
                        tags: { screen: 'ExportWizardModal', surface: testIDPrefix, method: 'share' },
                        // The COUNT and the format, never which articles. There
                        // is no record anywhere of what a reader exported.
                        extra: { format, rows: chosenIds.length },
                    });
                    onFailed();
                }
                onClose();
            } catch (error) {
                // Serialising or handing off THREW rather than returning a
                // result. Without this the modal would sit there having done
                // nothing: the spinner clears in `finally`, but neither
                // `onFailed` nor `onClose` would ever run, and the house rule
                // is that a feature says why it could not run and never
                // silently does nothing.
                logger.captureException(error, {
                    tags: { screen: 'ExportWizardModal', surface: testIDPrefix, method: 'share' },
                    extra: { format },
                });
                onFailed();
                onClose();
            } finally {
                setSharingFormat(null);
            }
        },
        [
            buildContent,
            chosenIds,
            dialogTitle,
            fileBaseName,
            includeReason,
            onClose,
            onFailed,
            sharingFormat,
            testIDPrefix,
        ],
    );

    const renderRow: ListRenderItem<ExportWizardRow> = useCallback(
        ({ item }) => {
            const checked = selected.has(item.id);
            return (
                <Pressable
                    testID={`${testIDPrefix}-row-${item.id}`}
                    onPress={() => toggleOne(item.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    className="flex-row items-center py-3 px-1 border-b border-gray-800"
                >
                    <Box className="flex-1 pr-3">
                        <TranslatableDynamic
                            text={item.title || t('feed.newsCluster')}
                            originalText={item.titleOriginal}
                            originalLanguage={item.language}
                            size="sm"
                            showToggle={false}
                        />
                    </Box>
                    <CheckGlyph checked={checked} />
                </Pressable>
            );
        },
        [selected, t, testIDPrefix, toggleOne],
    );

    const keyExtractor = useCallback((row: ExportWizardRow) => row.id, []);

    const stepHeading =
        step === 1
            ? t('savedExport.step1Heading')
            : step === 2
              ? t('savedExport.step2Heading')
              : t('savedExport.step3Heading');

    const canAdvance = step === 1 ? selected.size > 0 : true;
    const listMaxHeight = Math.min(LIST_MAX_PX, windowHeight * LIST_MAX_FRACTION);

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg">
            <ModalBackdrop />
            <ModalContent>
                <ModalHeader className="pb-3">
                    {/* Three slots, and the two outer ones keep a placeholder
                        when empty so the heading never slides sideways between
                        steps. Same shape as OnboardingNavBar. */}
                    <HStack className="w-full items-center justify-between" space="sm">
                        {step > 1 ? (
                            <Pressable
                                testID={`${testIDPrefix}-back`}
                                onPress={() => setStep((s) => s - 1)}
                                hitSlop={12}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.back')}
                                className="p-1 rounded-full"
                            >
                                <MaterialIcons name="arrow-back" size={20} color="#FFFFFF" />
                            </Pressable>
                        ) : (
                            <Box className="w-7" />
                        )}

                        <VStack className="flex-1 items-center">
                            <Text size="xs" className="text-gray-500">
                                {t('onboarding.stepOf', { current: step, total: TOTAL_STEPS })}
                            </Text>
                            <Text
                                className="text-base font-semibold text-white text-center"
                                numberOfLines={2}
                            >
                                {stepHeading}
                            </Text>
                        </VStack>

                        {step < TOTAL_STEPS ? (
                            <Pressable
                                testID={`${testIDPrefix}-next`}
                                onPress={() => canAdvance && setStep((s) => s + 1)}
                                disabled={!canAdvance}
                                hitSlop={12}
                                accessibilityRole="button"
                                accessibilityState={{ disabled: !canAdvance }}
                                accessibilityLabel={t('common.next')}
                                className="p-1 rounded-full"
                            >
                                <Text
                                    size="sm"
                                    className={
                                        canAdvance
                                            ? 'font-semibold text-primary-500'
                                            : 'font-semibold text-gray-600'
                                    }
                                >
                                    {t('common.next')}
                                </Text>
                            </Pressable>
                        ) : (
                            <Box className="w-7" />
                        )}
                    </HStack>
                </ModalHeader>

                {/* Step 1 does NOT render inside ModalBody; steps 2 and 3 do.
                    `ModalBody` IS a ScrollView (`Body: ScrollView`,
                    components/ui/modal/index.tsx:42), and a FlatList inside a
                    ScrollView of the same orientation is React Native's
                    "VirtualizedLists should never be nested" warning: windowing
                    breaks, so the list renders every row it has rather than a
                    window, and its scrolling fights the parent's. The row list
                    bounds and scrolls ITSELF through `maxHeight`, so it needs no
                    ScrollView around it at all. Steps 2 and 3 are short, hold no
                    virtualised list, and keep ModalBody so their content can
                    still scroll on a small screen. `mt-2 mb-6` is ModalBody's own
                    base spacing, reproduced here so the two look identical.

                    Note what did NOT catch this: every component test here mocks
                    ModalBody to a plain View, so the nesting the warning is about
                    does not exist in the test tree. Same family as a class-name
                    assertion that cannot see colour. */}
                {step === 1 ? (
                    <Box testID={`${testIDPrefix}-modal`} className="mt-2 mb-6">
                        {/* PINNED above the list, never a
                            ListHeaderComponent. Two reasons and both
                            matter: select-all must not scroll away, and
                            a hand-rolled FlatList mock silently drops
                            the props it did not destructure, which
                            makes every absence assertion over a header
                            in that slot pass for the wrong reason. */}
                        <Pressable
                            testID={`${testIDPrefix}-select-all`}
                            onPress={toggleAll}
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked: allSelected }}
                            className="flex-row items-center justify-between py-3 px-1 border-b border-gray-700"
                        >
                            <VStack className="flex-1 pr-3">
                                <Text size="sm" className="text-white font-semibold">
                                    {t('savedExport.selectAll')}
                                </Text>
                                <Text
                                    testID={`${testIDPrefix}-count`}
                                    size="xs"
                                    className="text-gray-500"
                                >
                                    {t('savedExport.selectedCount', {
                                        count: selected.size,
                                    })}
                                </Text>
                            </VStack>
                            <CheckGlyph checked={allSelected} />
                        </Pressable>

                        <FlatList
                            // Rows below the first screen ask for their translation only
                            // when a scroll tick finds them on screen (lib/visibility-tick).
                            onScroll={notifyScrollTick}
                            scrollEventThrottle={16}
                            onContentSizeChange={notifyScrollTick}
                            testID={`${testIDPrefix}-list`}
                            data={rows}
                            renderItem={renderRow}
                            keyExtractor={keyExtractor}
                            style={{ maxHeight: listMaxHeight }}
                            showsVerticalScrollIndicator={false}
                        />
                    </Box>
                ) : (
                    <ModalBody className="py-2">
                        <Box testID={`${testIDPrefix}-modal`}>
                            {step === 2 ? (
                                <Pressable
                                    testID={`${testIDPrefix}-include-reason`}
                                    onPress={() => setIncludeReason((v) => !v)}
                                    accessibilityRole="checkbox"
                                    accessibilityState={{ checked: includeReason }}
                                    className="flex-row items-center py-3 px-1"
                                >
                                    <VStack className="flex-1 pr-3">
                                        <Text size="sm" className="text-white">
                                            {t('savedExport.includeReason')}
                                        </Text>
                                        <Text size="xs" className="text-gray-500 mt-0.5">
                                            {reasonHint}
                                        </Text>
                                    </VStack>
                                    <CheckGlyph checked={includeReason} />
                                </Pressable>
                            ) : null}

                            {step === 3 ? (
                                <VStack space="sm" className="py-1">
                                    {(
                                        [
                                            ['markdown', 'formatMarkdown', 'formatMarkdownHint'],
                                            ['json', 'formatJson', 'formatJsonHint'],
                                        ] as const
                                    ).map(([format, labelKey, hintKey]) => (
                                        <Pressable
                                            key={format}
                                            testID={`${testIDPrefix}-format-${format}`}
                                            onPress={() => handleShare(format)}
                                            disabled={sharingFormat !== null}
                                            accessibilityRole="button"
                                            className="flex-row items-center border border-gray-700 rounded-lg px-3 py-3"
                                        >
                                            <VStack className="flex-1 pr-3">
                                                <Text size="sm" className="text-white font-semibold">
                                                    {t(`savedExport.${labelKey}`)}
                                                </Text>
                                                <Text size="xs" className="text-gray-500 mt-0.5">
                                                    {t(`savedExport.${hintKey}`)}
                                                </Text>
                                            </VStack>
                                            {sharingFormat === format ? (
                                                <Spinner size="small" />
                                            ) : (
                                                <MaterialIcons
                                                    name="ios-share"
                                                    size={20}
                                                    color={ACCENT}
                                                />
                                            )}
                                        </Pressable>
                                    ))}
                                </VStack>
                            ) : null}
                        </Box>
                    </ModalBody>
                )}

                <ModalFooter className="border-t border-gray-700 pt-4">
                    <Button
                        testID={`${testIDPrefix}-cancel`}
                        variant="outline"
                        action="secondary"
                        onPress={onClose}
                        isDisabled={sharingFormat !== null}
                        className="w-full"
                    >
                        <ButtonText>{t('common.cancel')}</ButtonText>
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
};

export default ExportWizardModal;
