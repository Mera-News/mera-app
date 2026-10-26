// One stored fact check in the Library list: a SUMMARY, never the check. The
// publication and when it was checked (or asked, while it runs), a New pill
// until the Fact checks page has been seen since, the headline, then ONE line:
// the first organisation and its own rating, "+N more" for the rest. Claims,
// sources and Mera's reading live on the article page (FactCheckPanel).
//
// KEYED ON STATUS: a row being re-checked is `pending` but still carries the
// previous verdict, so anything not finished shows the checking line.
//
// The delete control is a SIBLING of the tappable body, absolutely positioned
// over the meta row, never a child: nested, a delete could also navigate. Its
// 44pt frame is the frame itself, never hitSlop (QA measures a hitSlop target
// as its glyph box). The meta row keeps clear of it.

import { useNoteInk } from '@/components/custom/cards/FactChips';
import { useTapGuard } from '@/components/custom/cards/use-tap-guard';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { formatTimeAgo } from '@/lib/algorithms/time-ago';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import {
    describeCheckedBy,
    describeExternalChecks,
    describeOrganisationVerdict,
} from '@/lib/fact-check/fact-check-state';
import type { FactCheckRow } from '@/lib/fact-check/fact-check-types';
import { isFactCheckDone } from '@/lib/stores/fact-checks-store';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

interface FactCheckCardProps {
    readonly item: StoredFactCheck;
    /** Tapping the card body. Omit for a non-interactive card. */
    readonly onPress?: (item: StoredFactCheck) => void;
    /** The list passes a delete control (owner default L3: a check must never
     *  get stuck). */
    readonly onDelete?: (id: string) => void;
    /** Finished after the Fact checks page was last seen. */
    readonly isNew?: boolean;
    readonly testIDPrefix?: string;
}

const DELETE_FRAME = 44;
const PAD = 16;
const META_LINE = 18;

const FactCheckCard: React.FC<FactCheckCardProps> = ({
    item,
    onPress,
    onDelete,
    isNew = false,
    testIDPrefix = 'fact-check-card',
}) => {
    const { t } = useTranslation();
    const c = useColors();
    const note = useNoteInk();
    // Opens on a TAP only: a release after a sideways drag is not a press.
    const tap = useTapGuard(onPress ? () => onPress(item) : undefined);
    const done = isFactCheckDone(item);

    const payload = item.payload as FactCheckRow | null;
    const organisations = describeCheckedBy(payload?.checkedBy);
    const outcome = describeExternalChecks(item.status, organisations.length, payload?.checkedByStatus);
    const publication = payload?.publicationName?.trim() || null;
    const age = formatTimeAgo(t, done ? (item.resolvedAt ?? item.requestedAt) : item.requestedAt);
    const meta = { fontSize: 12, lineHeight: META_LINE, fontWeight: '700' as const, color: c.ink2 };
    const lead = organisations[0];
    const leadRating = (() => {
        const info = describeOrganisationVerdict(lead?.verdict);
        return info.isKey ? t(info.label as never) : info.label;
    })();
    const factIcon = <MaterialIcons name="fact-check" size={16} color={c.accent} {...DECORATIVE_ICON_A11Y} />;

    return (
        <View testID={`${testIDPrefix}-${item.id}`}>
            <Pressable
                onPress={tap.onPress}
                onPressIn={tap.onPressIn}
                disabled={!onPress}
                accessibilityRole={onPress ? 'button' : undefined}
                accessibilityLabel={onPress ? t('factCheck.dashboard.openA11y') : undefined}
                testID={`${testIDPrefix}-open-${item.id}`}
                style={[styles.card, { backgroundColor: c.surface, borderColor: c.line }]}
            >
                <View style={[styles.row, { gap: 6, paddingRight: onDelete ? DELETE_FRAME - 12 : 0 }]}>
                    {publication ? (
                        <>
                            <MaterialIcons name="newspaper" size={12} color={c.ink2} {...DECORATIVE_ICON_A11Y} />
                            <Text numberOfLines={1} style={[meta, { flexShrink: 1 }]}>{publication}</Text>
                        </>
                    ) : null}
                    <MaterialIcons
                        name="schedule"
                        size={12}
                        color={c.ink2}
                        style={publication ? { marginLeft: 10 } : undefined}
                        {...DECORATIVE_ICON_A11Y}
                    />
                    <Text numberOfLines={1} style={[meta, { flex: 1 }]}>
                        {t(done ? 'library.checks.checkedAge' : 'library.checks.askedAge', { age })}
                    </Text>
                    {isNew ? (
                        <View style={[styles.newPill, { backgroundColor: c.accent }]} testID={`${testIDPrefix}-new-${item.id}`}>
                            <Text style={{ fontSize: 11, lineHeight: 16, fontWeight: '700', color: c.onAccent }}>
                                {t('library.checks.new')}
                            </Text>
                        </View>
                    ) : null}
                </View>

                {item.articleTitle?.trim() ? (
                    <TranslatableDynamic text={item.articleTitle.trim()} size="xl" bold style={{ color: c.ink }} numberOfLines={3} />
                ) : (
                    <Text size="xl" bold style={{ color: c.ink }} numberOfLines={3}>
                        {t('factCheck.dashboard.untitled')}
                    </Text>
                )}

                <View style={[styles.summary, { backgroundColor: note.box }]} testID={`${testIDPrefix}-summary-${item.id}`}>
                    {outcome === 'pending' ? (
                        <>
                            <View style={[styles.dot, { backgroundColor: c.accent }]} testID={`${testIDPrefix}-checking-${item.id}`} />
                            <Text size="sm" style={{ color: c.ink2, flex: 1 }}>{`${t('library.checks.checking')}…`}</Text>
                        </>
                    ) : outcome === 'published' && lead ? (
                        <>
                            {factIcon}
                            <Text size="sm" bold numberOfLines={1} style={{ color: c.ink, flex: 1 }} testID={`${testIDPrefix}-org-${item.id}`}>
                                {lead.organisation.trim()}
                            </Text>
                            <View style={[styles.pill, { backgroundColor: c.surfaceRaised }]}>
                                <Text numberOfLines={1} style={[styles.pillText, { color: c.ink }]}>{leadRating}</Text>
                            </View>
                            {organisations.length > 1 ? (
                                <Text style={[styles.pillText, { color: c.ink3 }]} testID={`${testIDPrefix}-more-${item.id}`}>
                                    {t('library.checks.moreOrganisations', { count: organisations.length - 1 })}
                                </Text>
                            ) : null}
                        </>
                    ) : (
                        <>
                            {factIcon}
                            <Text size="sm" numberOfLines={2} style={{ color: c.ink2, flex: 1 }}>
                                {t(
                                    outcome === 'blocked'
                                        ? 'factCheck.blocked'
                                        : outcome === 'unavailable'
                                          ? 'factCheck.dashboard.couldNotCheck'
                                          : 'factCheck.dashboard.noneFound',
                                )}
                            </Text>
                        </>
                    )}
                </View>
            </Pressable>

            {onDelete ? (
                // A childless labelled button over the glyph (the glyph-leak
                // pattern), the 44pt frame being the box itself, centred on
                // the meta row.
                <View style={styles.deleteFrame}>
                    <MaterialIcons name="delete-outline" size={20} color={c.ink3} {...DECORATIVE_ICON_A11Y} />
                    <Pressable
                        onPress={() => onDelete(item.id)}
                        accessibilityRole="button"
                        accessibilityLabel={t('factCheck.dashboard.deleteA11y')}
                        testID={`${testIDPrefix}-delete-${item.id}`}
                        style={StyleSheet.absoluteFill}
                    />
                </View>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    card: { borderRadius: 16, borderWidth: 1, padding: PAD, gap: 8 },
    row: { flexDirection: 'row', alignItems: 'center' },
    newPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 },
    summary: { borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2, flexShrink: 0, maxWidth: '50%' },
    pillText: { fontSize: 12, lineHeight: 18, fontWeight: '600' },
    deleteFrame: {
        position: 'absolute',
        top: PAD + (META_LINE - DELETE_FRAME) / 2,
        right: PAD - 12,
        width: DELETE_FRAME,
        height: DELETE_FRAME,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default FactCheckCard;
