// One stored fact check (FinalLibrary #5, #6): the article it came from and
// when it was checked, a New pill until the Library's Fact checks page has
// been seen since, the title, the claim in its own box, then ONE ROW PER
// ORGANISATION with that organisation's own rating in its own words. A check
// still running says so in the same place.
//
// EXTERNALS ARE THE AUTHORITY (invariant 13): every rating here is an
// established fact-checking organisation's own, verbatim when we do not know
// the token. Mera's own verdict is never shown, in any state.
//
// The delete control is a SIBLING of the tappable body, absolutely positioned
// over its top-right corner, never a child: nested, a delete could also
// navigate. Its 44pt frame is the frame itself, never hitSlop (QA measures a
// hitSlop target as its glyph box). The header row keeps clear of it.

import { useTapGuard } from '@/components/custom/cards/use-tap-guard';
import { GLASS_EDGE, GlassPlate } from '@/components/custom/GlassSurface';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import { describeCheckedBy, describeOrganisationVerdict } from '@/lib/fact-check/fact-check-state';
import type { FactCheckedByEntry } from '@/lib/fact-check/fact-check-types';
import { isFactCheckDone } from '@/lib/stores/fact-checks-store';
import { useColors } from '@/lib/theme/tokens';
import { formatTimeAgo } from '@/lib/utils/time-ago';
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
const LINE = { fontSize: 14, lineHeight: 20 } as const;
const SMALL = { fontSize: 12, lineHeight: 17 } as const;

const FactCheckCard: React.FC<FactCheckCardProps> = ({
    item,
    onPress,
    onDelete,
    isNew = false,
    testIDPrefix = 'fact-check-card',
}) => {
    const { t } = useTranslation();
    const c = useColors();
    // Opens on a TAP only: a release after a sideways drag is not a press.
    const tap = useTapGuard(onPress ? () => onPress(item) : undefined);
    const done = isFactCheckDone(item);

    const payload = item.payload as { checkedBy?: FactCheckedByEntry[]; publicationName?: string | null } | null;
    const organisations = describeCheckedBy(payload?.checkedBy);
    const publication = payload?.publicationName?.trim() || null;
    const checkedAt = item.resolvedAt ?? item.requestedAt;
    const meta = [publication, t('library.checks.checkedAgo', { age: formatTimeAgo(t, checkedAt) })]
        .filter(Boolean)
        .join(' · ');
    const toneInk = { positive: c.positive, caution: c.accentText, neutral: c.ink2 } as const;

    return (
        <View testID={`${testIDPrefix}-${item.id}`}>
            <Pressable
                onPress={tap.onPress}
                onPressIn={tap.onPressIn}
                disabled={!onPress}
                accessibilityRole={onPress ? 'button' : undefined}
                accessibilityLabel={onPress ? t('factCheck.dashboard.openA11y') : undefined}
                testID={`${testIDPrefix}-open-${item.id}`}
                // Unpadded and clipping: GlassPlate is an absolute fill.
                className={`rounded-lg overflow-hidden ${GLASS_EDGE}`}
            >
                <GlassPlate />
                <VStack space="sm" className="p-3">
                    <HStack className="items-center" style={{ paddingRight: onDelete ? DELETE_FRAME - 8 : 0, gap: 8 }}>
                        <Text numberOfLines={1} style={[SMALL, { color: c.ink3, flex: 1 }]}>
                            {meta}
                        </Text>
                        {isNew ? (
                            <View style={[styles.newPill, { backgroundColor: c.accent }]} testID={`${testIDPrefix}-new-${item.id}`}>
                                <Text style={[SMALL, { color: c.onAccent, fontWeight: '700' }]}>{t('library.checks.new')}</Text>
                            </View>
                        ) : null}
                    </HStack>

                    {item.articleTitle?.trim() ? (
                        <TranslatableDynamic
                            text={item.articleTitle.trim()}
                            size="md"
                            className="font-semibold"
                            style={{ color: c.ink }}
                            numberOfLines={3}
                        />
                    ) : (
                        <Text size="md" className="font-semibold" style={{ color: c.ink }} numberOfLines={3}>
                            {t('factCheck.dashboard.untitled')}
                        </Text>
                    )}

                    {item.claim ? (
                        <View style={[styles.box, { backgroundColor: c.surface, borderColor: c.line }]}>
                            <Text style={[SMALL, { color: c.ink3, fontWeight: '600' }]}>{t('library.checks.claim')}</Text>
                            <TranslatableDynamic text={item.claim} size="sm" style={{ color: c.ink2 }} numberOfLines={3} />
                        </View>
                    ) : null}

                    {!done ? (
                        <View style={[styles.box, { backgroundColor: c.surface, borderColor: c.line }]} testID={`${testIDPrefix}-checking-${item.id}`}>
                            <Text style={[LINE, { color: c.ink2 }]}>{t('library.checks.checking')}</Text>
                        </View>
                    ) : (
                        organisations.map((entry, index) => {
                            // Verbatim when unrecognised: a rating is the
                            // organisation's own editorial copy (never translated).
                            const info = describeOrganisationVerdict(entry.verdict);
                            const rating = info.isKey ? (t as unknown as (k: string) => string)(info.label) : info.label;
                            return (
                                <HStack
                                    key={`${entry.organisation}-${index}`}
                                    className="items-center justify-between"
                                    style={{ gap: 12 }}
                                    testID={`${testIDPrefix}-org-${item.id}-${index}`}
                                >
                                    <Text numberOfLines={1} style={[LINE, { color: c.ink2, flexShrink: 1 }]}>
                                        {entry.organisation.trim()}
                                    </Text>
                                    <Text numberOfLines={1} style={[LINE, { color: toneInk[info.tone], fontWeight: '600', maxWidth: '55%' }]}>
                                        {rating}
                                    </Text>
                                </HStack>
                            );
                        })
                    )}
                </VStack>
            </Pressable>

            {onDelete ? (
                // A childless labelled button over the glyph (the glyph-leak
                // pattern), the 44pt frame being the box itself.
                <View style={styles.deleteFrame}>
                    <MaterialIcons
                        name="delete-outline"
                        size={20}
                        color={c.ink3}
                        accessible={false}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    />
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
    newPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 },
    box: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 2 },
    deleteFrame: {
        position: 'absolute',
        top: 0,
        right: 0,
        width: DELETE_FRAME,
        height: DELETE_FRAME,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default FactCheckCard;
