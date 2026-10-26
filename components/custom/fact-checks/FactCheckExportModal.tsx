import ExportWizardModal, {
    type ExportToggle,
    type ExportWizardRow,
} from '@/components/custom/saved-suggestions/ExportWizardModal';
import type { ExportFormat } from '@/components/custom/saved-suggestions/export-and-share';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import { describeCheckedBy, describeOrganisationVerdict, isTerminalStatus } from '@/lib/fact-check/fact-check-state';
import {
    buildFactChecksJson,
    buildFactChecksMarkdown,
    factCheckTextLabels,
    toFactCheckExportRows,
    type FactCheckExportOptions,
} from '@/lib/fact-check/fact-check-text';
import type { FactCheckRow } from '@/lib/fact-check/fact-check-types';
import { exportDay } from '@/lib/saved-articles-export';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface FactCheckExportModalProps {
    readonly isOpen: boolean;
    readonly onClose: () => void;
    /** Exactly what the Fact checks list shows. */
    readonly items: readonly StoredFactCheck[];
    readonly onFailed: () => void;
}

/** The Fact checks page's export: the shared wizard over the stored checks.
 *  Finished ones start ticked; one still running is shown but not pickable
 *  (mid-recheck it still holds the previous verdict). */
const FactCheckExportModal: React.FC<FactCheckExportModalProps> = ({ isOpen, onClose, items, onFailed }) => {
    const { t } = useTranslation();

    const rows = useMemo<ExportWizardRow[]>(
        () =>
            items.map((item) => {
                const payload = item.payload as FactCheckRow | null;
                const done = isTerminalStatus(item.status);
                const orgs = describeCheckedBy(payload?.checkedBy);
                const lead = orgs[0];
                const rating = (() => {
                    const info = describeOrganisationVerdict(lead?.verdict);
                    return info.isKey ? t(info.label as never) : info.label;
                })();
                const finding = !done
                    ? t('factCheckExport.stillChecking')
                    : orgs.length > 1
                      ? t('library.checks.count', { count: orgs.length })
                      : lead
                        ? `${lead.organisation.trim()}: ${rating}`
                        : t('factCheck.dashboard.noneFound');
                return {
                    id: item.id,
                    title: item.articleTitle?.trim() || t('factCheck.dashboard.untitled'),
                    subtitle: [payload?.publicationName?.trim(), finding].filter(Boolean).join(' · '),
                    disabled: !done,
                };
            }),
        [items, t],
    );

    const toggles = useMemo<ExportToggle<FactCheckExportOptions>[]>(
        () => [
            { id: 'claims', key: 'includeClaims', label: t('factCheck.claimsHeading'), hint: t('factCheckExport.includeClaimsHint'), defaultOn: true },
            { id: 'summary', key: 'includeSummary', label: t('factCheckExport.includeSummary'), hint: t('factCheckExport.includeSummaryHint'), defaultOn: true },
            { id: 'sources', key: 'includeSources', label: t('factCheck.share.sources'), hint: t('factCheckExport.includeSourcesHint'), defaultOn: true },
        ],
        [t],
    );

    const buildContent = useCallback(
        (chosenIds: string[], options: FactCheckExportOptions, format: ExportFormat) => {
            const chosen = new Set(chosenIds);
            const exportRows = toFactCheckExportRows(items.filter((item) => chosen.has(item.id)), options);
            return format === 'markdown'
                ? buildFactChecksMarkdown(exportRows, {
                      ...factCheckTextLabels(t),
                      docTitle: t('factCheck.title'),
                      docExported: t('savedExport.docExported', { date: exportDay() }),
                  })
                : buildFactChecksJson(exportRows, options);
        },
        [items, t],
    );

    return (
        <ExportWizardModal
            isOpen={isOpen}
            onClose={onClose}
            rows={rows}
            buildContent={buildContent}
            onFailed={onFailed}
            dialogTitle={t('factCheckExport.shareDialogTitle')}
            toggles={toggles}
            step1Heading={t('factCheckExport.step1Heading')}
            includeIntro={t('factCheckExport.includeIntro')}
            testIDPrefix="fact-check-export"
            initiallyAllSelected
            fileBaseName="mera-fact-checks"
        />
    );
};

export default FactCheckExportModal;
