/**
 * A fact check as plain text: the article panel's Share message (one check)
 * and the Library's export (several, as Markdown or JSON). Pure: copy comes in
 * through `FactCheckTextLabels`, so the caller picks the language.
 *
 * Organisation names and raw ratings are data, never re-worded here; the
 * labels decide how a rating reads (`describeOrganisationVerdict`). Only
 * secure links leave the device. A row that is not terminal is never
 * exported: during a recheck it is `pending` but still holds the OLD verdict.
 */

import { isSecureUrl } from '../algorithms/secure-url';
import type { StoredFactCheck } from '../database/services/fact-check-record-service';
import type { TFunction } from 'i18next';
import { describeAssessment, describeCheckedBy, describeOrganisationVerdict, isTerminalStatus } from './fact-check-state';
import type { FactCheckRow } from './fact-check-types';

export interface FactCheckTextLabels {
    factChecks: string;
    claims: string;
    /** Names the summary as AI-written, e.g. "Mera's AI summary (written by AI, can be wrong)". */
    aiSummary: string;
    sources: string;
    /** Export only: the line under a check nobody has published on. */
    noneFound: string;
    /** An organisation's raw rating as the reader sees it. */
    rating: (raw: string | null) => string;
    /** A claim's raw assessment as the reader sees it. */
    assessment: (raw: string) => string;
    rated: (organisation: string, rating: string, summary: string | null) => string;
}

/** The labels in one language (`lng`, else the app's): Share writes them in the
 *  language of the headline it shares, like `useShareArticle`'s footer. */
export function factCheckTextLabels(t: TFunction, lng?: string): FactCheckTextLabels {
    const tr = (key: string, opts: Record<string, unknown> = {}): string =>
        (t as unknown as (k: string, o: object) => string)(key, { ...opts, lng });
    return {
        factChecks: tr('factCheck.title'),
        claims: tr('factCheck.claimsHeading'),
        aiSummary: tr('factCheck.share.aiSummary'),
        sources: tr('factCheck.share.sources'),
        noneFound: tr('factCheck.dashboard.noneFound'),
        rating: (raw) => {
            const info = describeOrganisationVerdict(raw);
            return info.isKey ? tr(info.label) : info.label;
        },
        assessment: (raw) => tr(describeAssessment(raw).labelKey),
        rated: (organisation, rating, summary) =>
            summary
                ? tr('factCheck.share.ratedSaid', { organisation, rating, summary })
                : tr('factCheck.share.rated', { organisation, rating }),
    };
}

/** "24 Oct 2026" in `lng`; null for no date or one that does not parse. */
export function shareDate(value: string | number | null | undefined, lng?: string): string | null {
    if (value === null || value === undefined || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const opts = { day: 'numeric', month: 'short', year: 'numeric' } as const;
    try {
        return date.toLocaleDateString(lng, opts);
    } catch {
        // RangeError on a malformed tag: never throw out of a share.
        return date.toLocaleDateString(undefined, opts);
    }
}

/** "https://www.thefederal.com/x" -> "thefederal.com", the label of a source row. */
export function sourceDomain(uri: string): string {
    return uri.match(/^https?:\/\/(?:www\.)?([^/?#]+)/i)?.[1] ?? uri;
}

export interface FactCheckContent {
    factChecks: { organisation: string; rating: string | null; summary: string | null; url: string | null }[];
    claims: { claim: string; assessment: string }[];
    summary: string | null;
    sources: string[];
}

const oneLine = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
const secure = (url: string | null | undefined): string | null => (url && isSecureUrl(url) ? url : null);

export function factCheckContent(payload: FactCheckRow | null): FactCheckContent {
    return {
        factChecks: describeCheckedBy(payload?.checkedBy).map((entry) => ({
            organisation: entry.organisation.trim(),
            rating: oneLine(entry.verdict) || null,
            summary: oneLine(entry.summary) || null,
            url: secure(entry.url),
        })),
        claims: (payload?.claims ?? [])
            .filter((c) => !!c && oneLine(c.claim))
            .map((c) => ({ claim: oneLine(c.claim), assessment: c.assessment ?? '' })),
        summary: oneLine(payload?.summary) || null,
        sources: (payload?.citations ?? []).map((c) => secure(c?.uri)).filter((u): u is string => !!u),
    };
}

const ratedLine = (entry: FactCheckContent['factChecks'][number], labels: FactCheckTextLabels) =>
    labels.rated(entry.organisation, labels.rating(entry.rating), entry.summary);

const claimLines = (claims: FactCheckContent['claims'], labels: FactCheckTextLabels) =>
    claims.map((c, i) => `${i + 1}. ${c.claim} ${labels.assessment(c.assessment)}`);

/** Joins a heading and its lines, or nothing when there are no lines. */
const section = (heading: string, lines: string[]): string | null =>
    lines.length > 0 ? [heading, ...lines].join('\n') : null;

/**
 * The Share message: headline block, fact checks, claims, Mera's AI summary,
 * sources, then the footer, blank-line separated. Empty sections are left out.
 */
export function buildFactCheckShareMessage(params: {
    article: { title: string | null; publication: string | null; date: string | null; url: string | null };
    content: FactCheckContent;
    labels: FactCheckTextLabels;
    footer: string;
}): string {
    const { article, content, labels, footer } = params;
    const byline = [article.publication, article.date].filter(Boolean).join(', ');
    const head = [article.title, byline, article.url].filter(Boolean).join('\n');
    return [
        head || null,
        section(labels.factChecks, content.factChecks.flatMap((e) => [ratedLine(e, labels), ...(e.url ? [e.url] : [])])),
        section(labels.claims, claimLines(content.claims, labels)),
        section(labels.aiSummary, content.summary ? [content.summary] : []),
        section(labels.sources, content.sources),
        footer,
    ].filter(Boolean).join('\n\n');
}

export interface FactCheckExportOptions {
    includeClaims: boolean;
    includeSummary: boolean;
    includeSources: boolean;
}

/** One exported check. `null` = not included; `[]` = included, none found. */
export interface FactCheckExportRow {
    title: string;
    publication: string | null;
    url: string | null;
    checkedAt: string | null;
    factChecks: FactCheckContent['factChecks'];
    claims: FactCheckContent['claims'] | null;
    meraAiSummary: string | null;
    sources: string[] | null;
}

export function toFactCheckExportRows(
    items: readonly StoredFactCheck<FactCheckRow>[],
    opts: FactCheckExportOptions,
): FactCheckExportRow[] {
    return items.filter((item) => isTerminalStatus(item.status)).map((item) => {
        const content = factCheckContent(item.payload);
        const checked = item.resolvedAt ?? item.requestedAt;
        return {
            title: oneLine(item.articleTitle ?? item.payload?.articleTitle),
            publication: oneLine(item.payload?.publicationName) || null,
            url: secure(item.payload?.articleUrl),
            checkedAt: checked ? new Date(checked).toISOString() : null,
            factChecks: content.factChecks,
            claims: opts.includeClaims ? content.claims : null,
            meraAiSummary: opts.includeSummary ? content.summary : null,
            sources: opts.includeSources ? content.sources : null,
        };
    });
}

export function buildFactChecksMarkdown(
    rows: readonly FactCheckExportRow[],
    labels: FactCheckTextLabels & { docTitle: string; docExported: string },
): string {
    const out: string[] = [`# ${labels.docTitle}`, '', labels.docExported];
    const block = (heading: string, lines: string[]) => {
        if (lines.length > 0) out.push('', `**${heading}**`, ...lines);
    };
    for (const row of rows) {
        out.push('', `## ${row.title || labels.factChecks}`);
        const meta = [row.publication, row.checkedAt?.slice(0, 10)].filter(Boolean);
        if (meta.length > 0) out.push(meta.join(' · '));
        if (row.url) out.push(row.url);
        out.push('');
        if (row.factChecks.length === 0) out.push(labels.noneFound);
        for (const entry of row.factChecks) {
            out.push(`- ${ratedLine(entry, labels)}${entry.url ? ` ${entry.url}` : ''}`);
        }
        block(labels.claims, claimLines(row.claims ?? [], labels));
        block(labels.aiSummary, row.meraAiSummary ? [row.meraAiSummary] : []);
        block(labels.sources, (row.sources ?? []).map((u) => `- ${u}`));
    }
    out.push('');
    return out.join('\n');
}

export function buildFactChecksJson(
    rows: readonly FactCheckExportRow[],
    opts: FactCheckExportOptions,
    now: Date = new Date(),
): string {
    return JSON.stringify(
        {
            exportedAt: now.toISOString(),
            count: rows.length,
            includesClaims: opts.includeClaims,
            includesMeraAiSummary: opts.includeSummary,
            includesSources: opts.includeSources,
            factChecks: rows,
        },
        null,
        2,
    );
}
