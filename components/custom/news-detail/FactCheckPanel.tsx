import AiDisclosureCaption from '@/components/custom/AiDisclosureCaption';
import { useNoteInk } from '@/components/custom/cards/FactChips';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { secureUrlOrNull, isSecureUrl } from '@/lib/algorithms/secure-url';
import { formatTimeAgo } from '@/lib/algorithms/time-ago';
import { WEBSITE_URL } from '@/lib/config/branding';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import { requestFactCheckAgain } from '@/lib/fact-check/fact-check-graphql-client';
import {
    describeAssessment,
    describeExternalChecks,
    describeOrganisationVerdict,
    isTerminalStatus,
    recheckState,
    type FactCheckTone,
} from '@/lib/fact-check/fact-check-state';
import {
    buildFactCheckShareMessage,
    factCheckContent,
    factCheckTextLabels,
    shareDate,
    sourceDomain,
} from '@/lib/fact-check/fact-check-text';
import type { FactCheckRow } from '@/lib/fact-check/fact-check-types';
import { useFactCheck } from '@/lib/fact-check/use-fact-check';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useColors } from '@/lib/theme/tokens';
import { resolveUiLocale } from '@/lib/translation-service';
import { appendReferrer, openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Share, StyleSheet, View } from 'react-native';

/** The article as the screen shows it, for Share. Every field falls back to
 *  what the stored server row carries. */
export interface FactCheckShareArticle {
    readonly title?: string | null;
    /** Language of `title`: Share writes its labels and footer in it. */
    readonly language?: string | null;
    readonly publication?: string | null;
    readonly pubDate?: string | number | null;
    readonly url?: string | null;
}

interface FactCheckPanelProps {
    readonly articleId: string | null | undefined;
    readonly testIDPrefix?: string;
    /** The reader asked for a check from THIS screen's action row just now.
     *  Shows the working state immediately (see the render gate below). */
    readonly startedByReader?: boolean;
    readonly article?: FactCheckShareArticle;
}

/** Sources shown before "Show N more". */
const SOURCES_SHOWN = 3;

/**
 * The article-detail fact check: a PURE OBSERVER of this device's stored rows
 * plus `useFactCheck`'s server poll. Starting a check is the action-row tick
 * (`requestArticleFactCheck`); this card only asks again ("Fact check
 * again", the reader's own tap). A check is shown only to the device that
 * asked for it (navx).
 *
 *   absent     -> nothing. Most articles are never asked about.
 *   processing -> the working state, gated so a near-instant answer never
 *                 flashes a spinner.
 *   stalled    -> the poll gave up at its ceiling. NEVER rendered like
 *                 `absent` (r14 shipped that bug once): its own honest line.
 *   terminal   -> one card per row: published fact checks, what Mera found
 *                 (labelled AI), claims, sources, the disclaimer, then Share
 *                 and Fact check again.
 *
 * KEYED ON STATUS, NEVER ON THE VERDICT FIELDS. While a recheck runs the row
 * is `pending` but still carries the previous verdict, summary and checkedBy;
 * only terminal rows render a card, so the stale answer is never shown as the
 * current one.
 *
 * Externals are the authority: published organisations come first, each
 * rating in the organisation's own words in a neutral pill. Mera's own reading
 * sits under them, labelled AI-generated, and states no verdict.
 */
const FactCheckPanel: React.FC<FactCheckPanelProps> = ({
    articleId,
    testIDPrefix = 'fact-check',
    startedByReader = false,
    article,
}) => {
    const { t } = useTranslation();
    const c = useColors();
    const { phase, showProgress, rows } = useFactCheck(articleId);

    // OPEN by default and not persisted: the header no longer carries the
    // finding, so a folded card would hide everything. Keyed by row id so a
    // second row cannot inherit the first's state.
    const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
    const toggle = React.useCallback((id: string) => {
        setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);

    if (phase === 'absent' && !startedByReader) return null;

    const terminalRows = rows.filter((row) => isTerminalStatus(row.status));
    const showWorking =
        (phase === 'processing' && (showProgress || startedByReader)) ||
        (phase === 'absent' && startedByReader);
    const showStalled = phase === 'stalled';
    if (terminalRows.length === 0 && !showWorking && !showStalled) return null;

    const box = [styles.card, { backgroundColor: c.surface, borderColor: c.line }];

    return (
        <View style={{ gap: 12 }} testID={`${testIDPrefix}-panel`}>
            {showStalled ? (
                // Its own block: the working block promises an answer soon,
                // which is no longer honest once the poll has given up.
                <View style={[box, styles.padded]} testID={`${testIDPrefix}-stalled`}>
                    <Text size="sm" style={{ color: c.ink }}>{t('factCheck.stillChecking')}</Text>
                </View>
            ) : null}

            {showWorking ? (
                <View style={[box, styles.padded, { gap: 6 }]} testID={`${testIDPrefix}-working`}>
                    <View style={styles.row}>
                        <Spinner size="small" />
                        <View style={{ flex: 1 }}>
                            <Text size="sm" style={{ color: c.ink }}>{t('factCheck.checking')}</Text>
                            <Text size="xs" style={{ color: c.ink2 }}>{t('factCheck.explainer')}</Text>
                        </View>
                    </View>
                    {/* The job survives navigation and a kill: nothing to wait here for. */}
                    <Text size="xs" style={{ color: c.ink2 }}>{t('factCheck.queued')}</Text>
                    <Text size="xs" style={{ color: c.ink3 }}>{t('factCheck.queuedHint')}</Text>
                </View>
            ) : null}

            {terminalRows.map((row, index) => (
                <FactCheckResult
                    key={row.id}
                    row={row}
                    open={collapsed[row.id] !== true}
                    onToggle={() => toggle(row.id)}
                    article={article}
                    testIDPrefix={`${testIDPrefix}-${index}`}
                />
            ))}
        </View>
    );
};

const FactCheckResult: React.FC<{
    readonly row: StoredFactCheck<FactCheckRow>;
    readonly open: boolean;
    readonly onToggle: () => void;
    readonly article?: FactCheckShareArticle;
    readonly testIDPrefix: string;
}> = ({ row, open, onToggle, article, testIDPrefix: id }) => {
    const { t } = useTranslation();
    const c = useColors();
    const note = useNoteInk();
    const appLanguage = useAppLanguage();
    const [showAllSources, setShowAllSources] = React.useState(false);
    const [asking, setAsking] = React.useState(false);

    const payload = row.payload;
    const content = factCheckContent(payload);
    const blocked = row.status === 'blocked';
    const checkedAt = row.resolvedAt ?? row.requestedAt;
    const checkedLabel = t('library.checks.checkedAge', { age: formatTimeAgo(t, checkedAt) });
    const outcome = describeExternalChecks(row.status, content.factChecks.length, payload?.checkedByStatus);
    const recheck = recheckState(row.status, payload?.recheckAvailableAt);
    const citations = (payload?.citations ?? []).filter((x) => !!x?.uri);
    const shownCitations = showAllSources ? citations : citations.slice(0, SOURCES_SHOWN);

    const toneInk: Record<FactCheckTone, string> = { positive: c.positive, caution: c.accentText, neutral: c.ink };
    const rating = (raw: string | null) => {
        const info = describeOrganisationVerdict(raw);
        return info.isKey ? t(info.label as never) : info.label;
    };

    const openLink = React.useCallback((uri: string) => {
        if (!isSecureUrl(uri)) return;
        // Third-party pages, not our publishers: no UTM referrer.
        openInAppBrowser(uri).catch((err) => {
            logger.captureException(err, { tags: { component: 'FactCheckPanel', method: 'openLink' } });
        });
    }, []);

    const share = async () => {
        // Labels and footer in the headline's language (useShareArticle's rule),
        // else the reader's own.
        const lng = resolveUiLocale(article?.language) ?? appLanguage;
        const title = article?.title?.trim() || row.articleTitle || payload?.articleTitle || null;
        const url = secureUrlOrNull(article?.url ?? payload?.articleUrl ?? null);
        try {
            const message = buildFactCheckShareMessage({
                article: {
                    title,
                    publication: article?.publication ?? payload?.publicationName ?? null,
                    date: shareDate(article?.pubDate, lng),
                    url: url ? appendReferrer(url, 'share') : null,
                },
                content,
                labels: factCheckTextLabels(t, lng),
                footer: t('factCheck.share.footer', {
                    date: shareDate(checkedAt, lng) ?? '',
                    downloadUrl: WEBSITE_URL,
                    lng,
                }),
            });
            await Share.share({ message }, { subject: title ?? undefined });
        } catch (err) {
            logger.captureException(err, { tags: { component: 'FactCheckPanel', method: 'share' } });
        }
    };

    const askAgain = async () => {
        if (asking || recheck !== 'available') return;
        void hapticLight();
        setAsking(true);
        // Never throws. A pending answer flips this row out of `terminalRows`
        // and the panel shows the working state; a too-early one comes back
        // with a future recheckAvailableAt and this button reads "Checked recently".
        await requestFactCheckAgain(row.articleId, row.articleTitle);
        setAsking(false);
    };

    const heading = (text: string) => (
        <Text accessibilityRole="header" style={[styles.heading, { color: c.ink }]}>{text}</Text>
    );

    return (
        <View
            testID={`${id}-result`}
            style={[styles.card, { backgroundColor: c.surface, borderColor: c.line, paddingBottom: open ? 16 : 4 }]}
        >
            {/* The whole header is the toggle: a long card can bury the article. */}
            <Pressable
                testID={`${id}-toggle`}
                onPress={onToggle}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                accessibilityLabel={t('factCheck.headerA11y', {
                    title: t('factCheck.panelTitle'),
                    status: checkedLabel,
                    action: open ? t('factCheck.collapseA11y') : t('factCheck.expandA11y'),
                })}
                style={[styles.row, { minHeight: 48 }]}
            >
                <MaterialIcons name="fact-check" size={20} color={c.accent} {...DECORATIVE_ICON_A11Y} />
                <Text style={[styles.title, { color: c.ink }]} numberOfLines={1}>{t('factCheck.panelTitle')}</Text>
                <Text style={[styles.caption, { color: c.ink3 }]}>{checkedLabel}</Text>
                <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={22} color={c.ink2} {...DECORATIVE_ICON_A11Y} />
            </Pressable>

            {!open ? null : blocked ? (
                <Text size="sm" style={{ color: c.ink2 }} testID={`${id}-blocked`}>{t('factCheck.blocked')}</Text>
            ) : (
                <>
                    <View style={styles.section} testID={`${id}-checked-by`}>
                        {outcome === 'published' ? (
                            <>
                                {heading(t('factCheck.publishedHeading'))}
                                <Text style={[styles.caption, { color: c.ink3 }]}>{t('factCheck.checkedByRelatedNote')}</Text>
                                {content.factChecks.map((entry, i) => {
                                    const ratingText = rating(entry.rating);
                                    const body = (
                                        <>
                                            <View style={styles.row}>
                                                <Text style={[styles.orgName, { color: c.ink }]}>{entry.organisation}</Text>
                                                <Pill text={ratingText} ink={c.ink} fill={c.surfaceRaised} />
                                                {entry.url ? <MaterialIcons name="open-in-new" size={16} color={c.ink3} {...DECORATIVE_ICON_A11Y} /> : null}
                                            </View>
                                            {entry.summary ? (
                                                <TranslatableDynamic text={entry.summary} size="sm" style={{ color: c.ink2 }} />
                                            ) : null}
                                        </>
                                    );
                                    const inset = [styles.inset, { backgroundColor: note.box, gap: 6, padding: 12 }];
                                    return entry.url ? (
                                        <Pressable
                                            key={`org-${i}`}
                                            onPress={() => openLink(entry.url as string)}
                                            accessibilityRole="link"
                                            accessibilityLabel={t('factCheck.organisationA11y', {
                                                organisation: entry.organisation,
                                                rating: ratingText,
                                            })}
                                            testID={`${id}-org-${i}`}
                                            style={inset}
                                        >
                                            {body}
                                        </Pressable>
                                    ) : (
                                        <View key={`org-${i}`} testID={`${id}-org-${i}`} style={inset}>{body}</View>
                                    );
                                })}
                            </>
                        ) : (
                            // Two different empty states, never collapsed: `unavailable`
                            // means the lookup did not run, so "nobody has published"
                            // would be a made-up all-clear.
                            <Text size="sm" style={{ color: c.ink2 }} testID={outcome === 'unavailable' ? `${id}-checked-by-unavailable` : undefined}>
                                {t(outcome === 'unavailable' ? 'factCheck.checkedByUnavailable' : 'factCheck.noCheckedBy')}
                            </Text>
                        )}
                    </View>

                    <View style={styles.section} testID={`${id}-own-reading`}>
                        <View style={styles.row}>
                            <View style={{ flex: 1 }}>{heading(t('factCheck.meraFoundHeading'))}</View>
                            <AiDisclosureCaption variant="compact" text={t('aiDisclosure.short')} color={note.ai} />
                        </View>
                        {payload?.summary ? (
                            <TranslatableDynamic text={payload.summary} size="sm" style={{ color: c.ink }} />
                        ) : (
                            <Text size="sm" style={{ color: c.ink }}>{t('factCheck.searchFoundEmpty')}</Text>
                        )}
                    </View>

                    {content.claims.length > 0 ? (
                        <View style={styles.section}>
                            {heading(t('factCheck.claimsHeading'))}
                            <View style={[styles.inset, { backgroundColor: note.box, paddingHorizontal: 12, paddingVertical: 4 }]}>
                                {content.claims.map((claim, i) => {
                                    const info = describeAssessment(claim.assessment);
                                    return (
                                        <View
                                            key={`claim-${i}`}
                                            testID={`${id}-claim-${i}`}
                                            style={[
                                                styles.claim,
                                                i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line } : null,
                                            ]}
                                        >
                                            <View style={{ flex: 1 }}>
                                                <TranslatableDynamic text={claim.claim} size="sm" style={{ color: c.ink }} />
                                            </View>
                                            <Pill text={t(info.labelKey as never)} ink={toneInk[info.tone]} fill={c.surfaceRaised} />
                                        </View>
                                    );
                                })}
                            </View>
                        </View>
                    ) : null}

                    <View style={[styles.section, { gap: 4 }]} testID={`${id}-citations`}>
                        {citations.length === 0 ? (
                            <Text size="xs" style={{ color: c.ink3 }} testID={`${id}-no-citations`}>{t('factCheck.noCitations')}</Text>
                        ) : (
                            <>
                                {heading(t('factCheck.sourcesCount', { count: citations.length }))}
                                {shownCitations.map((citation, i) => {
                                    const tappable = isSecureUrl(citation.uri);
                                    const label = sourceDomain(citation.uri);
                                    return (
                                        <Pressable
                                            key={`citation-${i}`}
                                            onPress={() => openLink(citation.uri)}
                                            disabled={!tappable}
                                            accessibilityRole="link"
                                            accessibilityLabel={t('factCheck.citationA11y', { source: label })}
                                            testID={`${id}-citation-${i}`}
                                            style={[styles.sourceRow, { borderBottomColor: c.line }]}
                                        >
                                            <Text numberOfLines={1} style={[styles.body, { flex: 1, color: tappable ? c.accentText : c.ink3 }]}>
                                                {label}
                                            </Text>
                                            {tappable ? <MaterialIcons name="open-in-new" size={16} color={c.ink3} {...DECORATIVE_ICON_A11Y} /> : null}
                                        </Pressable>
                                    );
                                })}
                                {citations.length > SOURCES_SHOWN && !showAllSources ? (
                                    <Pressable
                                        onPress={() => setShowAllSources(true)}
                                        accessibilityRole="button"
                                        testID={`${id}-sources-more`}
                                        style={styles.moreButton}
                                    >
                                        <Text style={[styles.body, { color: c.ink, fontWeight: '600' }]}>
                                            {t('factCheck.showMoreSources', { count: citations.length - SOURCES_SHOWN })}
                                        </Text>
                                    </Pressable>
                                ) : null}
                            </>
                        )}
                    </View>

                    <Text style={[styles.caption, { color: c.ink3 }]}>{t('factCheck.disclaimer')}</Text>

                    <View style={[styles.actions, { borderTopColor: c.line }]}>
                        <View style={styles.row}>
                            <OutlinedPill
                                icon="ios-share"
                                label={t('articleDetail.share')}
                                onPress={() => { void share(); }}
                                testID={`${id}-share`}
                            />
                            <OutlinedPill
                                icon="refresh"
                                label={recheck === 'recent' ? t('factCheck.checkedRecently') : t('factCheck.again')}
                                onPress={() => { void askAgain(); }}
                                disabled={recheck !== 'available' || asking}
                                testID={`${id}-again`}
                            />
                        </View>
                        <Text style={[styles.caption, { color: c.ink3, textAlign: 'center' }]}>{t('factCheck.againHint')}</Text>
                    </View>
                </>
            )}
        </View>
    );
};

/** A rating or assessment: neutral fill, the caller's ink. */
const Pill: React.FC<{ readonly text: string; readonly ink: string; readonly fill: string }> = ({ text, ink, fill }) => (
    <View style={[styles.pill, { backgroundColor: fill }]}>
        <Text numberOfLines={1} style={[styles.pillText, { color: ink }]}>{text}</Text>
    </View>
);

const OutlinedPill: React.FC<{
    readonly icon: React.ComponentProps<typeof MaterialIcons>['name'];
    readonly label: string;
    readonly onPress: () => void;
    readonly disabled?: boolean;
    readonly testID: string;
}> = ({ icon, label, onPress, disabled = false, testID }) => {
    const c = useColors();
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            testID={testID}
            style={[styles.outlined, { borderColor: c.edge, opacity: disabled ? 0.45 : 1 }]}
        >
            <MaterialIcons name={icon} size={18} color={c.ink} {...DECORATIVE_ICON_A11Y} />
            <Text numberOfLines={1} style={[styles.body, { color: c.ink, fontWeight: '600', flexShrink: 1 }]}>{label}</Text>
        </Pressable>
    );
};

const styles = StyleSheet.create({
    card: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 16, paddingTop: 4, gap: 16 },
    padded: { paddingVertical: 12 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    section: { gap: 8 },
    title: { flex: 1, fontSize: 18, lineHeight: 28, fontWeight: '700' },
    heading: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
    body: { fontSize: 14, lineHeight: 21 },
    caption: { fontSize: 12, lineHeight: 18 },
    orgName: { flex: 1, fontSize: 14, lineHeight: 21, fontWeight: '700' },
    inset: { borderRadius: 8 },
    claim: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 10 },
    pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2, flexShrink: 0, maxWidth: '55%' },
    pillText: { fontSize: 12, lineHeight: 18, fontWeight: '600' },
    sourceRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 44,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    moreButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
    actions: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16, gap: 8 },
    outlined: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 44,
        borderRadius: 999,
        borderWidth: 1,
        paddingHorizontal: 12,
    },
});

export default FactCheckPanel;
