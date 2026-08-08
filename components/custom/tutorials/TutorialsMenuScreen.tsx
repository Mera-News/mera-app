import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
// Via the ui layer rather than `react-native` directly — a bare re-export that
// exists so tests can stub one module path. Same reason as `SlideView`.
import { ScrollView } from '@/components/ui/scroll-view';

import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { hapticLight } from '@/lib/haptics';
import { buildMenuModel } from '@/lib/tutorials/menu';
import { chapterSubtitleKey, chapterTitleKey } from '@/lib/tutorials/keys';
import { useTutorialsStore } from '@/lib/stores/tutorials-store';
import type { ChapterId, ChapterLevel } from '@/lib/tutorials/types';
import {
    TUTORIAL_ACCENT,
    TUTORIAL_ACCENT_EDGE,
    TUTORIAL_ACCENT_SOFT,
    TUTORIAL_MUTED,
    TUTORIAL_MUTED_EDGE,
    TUTORIAL_TEXT_DIM,
} from './theme';
import { useTutorialCopy } from './use-tutorial-copy';

interface TutorialsMenuScreenProps {
    readonly onBack: () => void;
    readonly onOpenChapter: (chapterId: ChapterId) => void;
}

/**
 * The "Welcome to mera" menu: two sections, twelve chapters, a tick per finished
 * one.
 *
 * The advanced section is HIDDEN rather than shown-and-disabled until three
 * basics are done (`lib/tutorials/menu.ts`). A row you cannot open is a dead
 * end; the one-line note says the same thing without pretending to be tappable.
 */
const TutorialsMenuScreen: React.FC<TutorialsMenuScreenProps> = ({
    onBack,
    onOpenChapter,
}) => {
    const t = useTutorialCopy();
    const completed = useTutorialsStore((s) => s.completed);
    const hydrated = useTutorialsStore((s) => s.hydrated);

    // Belt and braces. `hydrate()` also runs in the app's startup Promise.all,
    // but the menu is reachable from a deep link on a cold start where that has
    // not landed yet, and re-running it is one indexed query.
    useEffect(() => {
        if (!hydrated) void useTutorialsStore.getState().hydrate();
        useTutorialsStore.getState().markMenuSeen();
    }, [hydrated]);

    const model = useMemo(() => buildMenuModel(completed), [completed]);

    const handleOpen = useCallback(
        (chapterId: ChapterId) => {
            void hapticLight();
            onOpenChapter(chapterId);
        },
        [onOpenChapter],
    );

    const sectionLabel = (level: ChapterLevel): string =>
        level === 'basic' ? t('tutorials.sectionBasic') : t('tutorials.sectionAdvanced');

    return (
        <View style={styles.root}>
            <DrillDownHeader
                title={t('tutorials.menuTitle')}
                subtitle={t('tutorials.progress', {
                    done: model.completedCount,
                    total: model.totalCount,
                })}
                onBack={onBack}
            />

            <ScrollView
                testID="tutorials-menu"
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                <Text style={styles.intro}>{t('tutorials.menuSubtitle')}</Text>

                {model.sections.map((section) => (
                    <View key={section.level} style={styles.section}>
                        <Text style={styles.sectionTitle}>{sectionLabel(section.level)}</Text>

                        {section.rows.map(({ chapter, completed: isDone }) => (
                            <Pressable
                                key={chapter.id}
                                testID={`tutorial-row-${chapter.id}`}
                                onPress={() => handleOpen(chapter.id)}
                                accessibilityRole="button"
                                accessibilityLabel={t(chapterTitleKey(chapter.id))}
                                accessibilityState={{ checked: isDone }}
                                style={styles.row}
                            >
                                <View style={[styles.rowIcon, isDone && styles.rowIconDone]}>
                                    <MaterialIcons
                                        name={chapter.icon}
                                        size={20}
                                        color={isDone ? TUTORIAL_ACCENT : TUTORIAL_TEXT_DIM}
                                    />
                                </View>

                                <View style={styles.rowBody}>
                                    <Text style={styles.rowTitle}>
                                        {t(chapterTitleKey(chapter.id))}
                                    </Text>
                                    <Text style={styles.rowSubtitle} numberOfLines={2}>
                                        {t(chapterSubtitleKey(chapter.id))}
                                    </Text>
                                </View>

                                <View style={styles.rowTail}>
                                    {isDone ? (
                                        <MaterialIcons
                                            name="check-circle"
                                            size={18}
                                            color={TUTORIAL_ACCENT}
                                            // The tick is the only thing marking
                                            // a finished row, so it carries the
                                            // word for anyone not seeing colour.
                                            accessibilityLabel={t('tutorials.completedBadge')}
                                        />
                                    ) : (
                                        <Text style={styles.rowCount}>
                                            {t('tutorials.slideCount', {
                                                count: chapter.slides.length,
                                            })}
                                        </Text>
                                    )}
                                    <MaterialIcons
                                        name="chevron-right"
                                        size={18}
                                        color={TUTORIAL_TEXT_DIM}
                                    />
                                </View>
                            </Pressable>
                        ))}
                    </View>
                ))}

                {model.advancedRemaining > 0 ? (
                    <View testID="tutorials-advanced-locked" style={styles.lockedCard}>
                        <MaterialIcons name="lock-outline" size={16} color={TUTORIAL_TEXT_DIM} />
                        <View style={styles.lockedBody}>
                            <Text style={styles.lockedTitle}>
                                {t('tutorials.advancedLockedTitle')}
                            </Text>
                            <Text style={styles.lockedText}>
                                {t('tutorials.advancedLockedBody', {
                                    count: model.advancedRemaining,
                                })}
                            </Text>
                        </View>
                    </View>
                ) : null}
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    content: {
        paddingHorizontal: 16,
        paddingBottom: 32,
        paddingTop: 12,
        gap: 8,
    },
    intro: {
        color: TUTORIAL_TEXT_DIM,
        fontSize: 13,
        lineHeight: 19,
        marginBottom: 8,
    },
    section: {
        gap: 8,
        marginBottom: 12,
    },
    sectionTitle: {
        color: TUTORIAL_TEXT_DIM,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        marginTop: 8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: TUTORIAL_MUTED_EDGE,
        backgroundColor: TUTORIAL_MUTED,
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    rowIcon: {
        width: 38,
        height: 38,
        borderRadius: 19,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderWidth: 1,
        borderColor: TUTORIAL_MUTED_EDGE,
    },
    rowIconDone: {
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        borderColor: TUTORIAL_ACCENT_EDGE,
    },
    rowBody: { flex: 1, gap: 3 },
    rowTitle: {
        color: '#ffffff',
        fontSize: 15,
        fontWeight: '600',
    },
    rowSubtitle: {
        color: TUTORIAL_TEXT_DIM,
        fontSize: 12,
        lineHeight: 17,
    },
    rowTail: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    rowCount: {
        color: TUTORIAL_TEXT_DIM,
        fontSize: 11,
    },
    lockedCard: {
        flexDirection: 'row',
        gap: 10,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: TUTORIAL_MUTED_EDGE,
        paddingHorizontal: 12,
        paddingVertical: 12,
        marginTop: 4,
    },
    lockedBody: { flex: 1, gap: 3 },
    lockedTitle: {
        color: '#ffffff',
        fontSize: 13,
        fontWeight: '600',
    },
    lockedText: {
        color: TUTORIAL_TEXT_DIM,
        fontSize: 12,
        lineHeight: 17,
    },
});

export default TutorialsMenuScreen;
