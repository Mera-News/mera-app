import type { SavedItem } from '@/lib/database/services/saved-article-suggestion-service';
import {
    buildSavedJson,
    buildSavedMarkdown,
    exportDay,
    toExportRows,
} from '@/lib/saved-articles-export';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportFormat } from './export-and-share';
import ExportWizardModal, { type ExportWizardRow } from './ExportWizardModal';
import { savedItemId } from './saved-item-id';

interface SavedExportModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Exactly what the Saved list is showing. `loadSavedItems()` has already
     *  dropped the retention origins, so the wizard offers the same set the
     *  reader can scroll and count, and never a superset of it. */
    items: SavedItem[];
    /** Raised when the export could not be handed off at all. The screen owns
     *  the toast so this component stays renderable in a test without one. */
    onFailed: () => void;
}

/** The Saved tab's export: `ExportWizardModal` over the tab's own rows. */
const SavedExportModal: React.FC<SavedExportModalProps> = ({
    isOpen,
    onClose,
    items,
    onFailed,
}) => {
    const { t } = useTranslation();

    // Rendered through TranslatableDynamic with the props the CARD passes, so a
    // row here reads the same as the row behind the modal. The exported file
    // deliberately carries the stored English headline instead; see
    // lib/saved-articles-export.ts.
    //
    // Branched on `origin` rather than through a nullable `suggestion` local: a
    // ternary over a derived value does not narrow the union back on the other
    // arm, so `item.article` is not reachable there.
    const rows = useMemo<ExportWizardRow[]>(
        () =>
            items.map((item) => ({
                id: savedItemId(item),
                title:
                    item.origin === 'suggestion'
                        ? (item.suggestion.title_en ?? '')
                        : (item.article.title_en ?? item.article.title),
                titleOriginal:
                    item.origin === 'suggestion'
                        ? (item.suggestion.title_original ?? undefined)
                        : item.article.title,
                language:
                    item.origin === 'suggestion'
                        ? (item.suggestion.language_code ?? undefined)
                        : (item.article.original_language_code ?? undefined),
            })),
        [items],
    );

    const buildContent = useCallback(
        (chosenIds: string[], includeReason: boolean, format: ExportFormat) => {
            const chosen = new Set(chosenIds);
            const exportRows = toExportRows(
                items.filter((item) => chosen.has(savedItemId(item))),
                { includeReason },
            );
            return format === 'markdown'
                ? buildSavedMarkdown(exportRows, {
                      docTitle: t('savedExport.docTitle'),
                      docExported: t('savedExport.docExported', { date: exportDay() }),
                      reasonLabel: t('savedExport.docReasonLabel'),
                  })
                : buildSavedJson(exportRows, { includeReason });
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
            dialogTitle={t('savedExport.shareDialogTitle')}
            reasonHint={t('savedExport.includeReasonHint')}
            testIDPrefix="saved-export"
        />
    );
};

export default SavedExportModal;
