// Export reading history: the local publication_visits log (it never leaves
// the phone until the reader picks a share target), shaped by the pure
// reading-history-export module and handed to the share sheet as JSON. Used by
// Your data and by Observability.
import { getAllVisitedArticles } from '@/lib/database/services/publication-visit-service';
import logger from '@/lib/logger';
import { buildReadingHistoryExport } from '@/lib/reading-history-export';
import { toastManager } from '@/lib/toast-manager';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share } from 'react-native';

export function useExportHistory(screen: string): { readonly exporting: boolean; readonly exportHistory: () => Promise<void> } {
    const { t } = useTranslation();
    const [exporting, setExporting] = useState(false);
    const exportHistory = useCallback(async () => {
        if (exporting) return;
        setExporting(true);
        try {
            const visits = await getAllVisitedArticles();
            if (visits.length === 0) {
                toastManager.showInfo(t('manageData.exportHistoryEmptyTitle'), t('manageData.exportHistoryEmptyDescription'));
                return;
            }
            await Share.share(
                { message: JSON.stringify(buildReadingHistoryExport(visits), null, 2) },
                { subject: t('manageData.exportHistorySubject') },
            );
        } catch (error) {
            logger.captureException(error, { tags: { screen, action: 'exportHistory' } });
            toastManager.showError(t('manageData.errorTitle'), t('manageData.errorDescription'));
        } finally {
            setExporting(false);
        }
    }, [exporting, screen, t]);
    return { exporting, exportHistory };
}
