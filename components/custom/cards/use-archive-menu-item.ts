// The ••• item that sends an article to Archive or moves it between Saved's two
// lists. The bookmark only ever saves to Read later, so this is the one way
// into Archive. Runs after the sheet has gone, so its toast is never painted
// under the Modal on Android.

import {
  deleteSavedSuggestion,
  getSavedList,
  moveSavedToList,
  type SavedList,
} from '@/lib/database/services/saved-article-suggestion-service';
import { hapticSuccess } from '@/lib/haptics';
import { useSavedList } from '@/lib/saved-state';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArticleMenuItem } from './ArticleOverflowMenu';

interface Input {
  /** The saved row's id: the suggestion's, or the article's for a standalone. */
  readonly savedId: string;
  readonly saved: boolean;
  /** Saves the article to a list. Stable, or the menu rebuilds each render. */
  readonly save: (list: SavedList) => Promise<void>;
}

export function useArchiveMenuItem({ savedId, saved, save }: Input): ArticleMenuItem {
  const { t } = useTranslation();
  const [listFromDb, setListFromDb] = useState<SavedList | null>(null);
  const override = useSavedList(savedId);

  // Read only for a saved article, so an unsaved row costs nothing here.
  useEffect(() => {
    if (!saved) return;
    let cancelled = false;
    getSavedList(savedId)
      .then((list) => {
        if (!cancelled) setListFromDb(list);
      })
      .catch(() => {
        /* non-fatal: the label falls back to Read later's */
      });
    return () => {
      cancelled = true;
    };
  }, [savedId, saved]);

  const list: SavedList | null = saved ? (override ?? listFromDb ?? 'later') : null;

  return useMemo(() => {
    const target: SavedList = list === 'archive' ? 'later' : 'archive';
    const run = async (): Promise<boolean> => {
      if (list) {
        if (!(await moveSavedToList(savedId, target))) return false;
      } else {
        await save('archive');
      }
      hapticSuccess();
      // Required at call time, as every toast under the card graph is.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { toastManager } = require('@/lib/toast-manager') as typeof import('@/lib/toast-manager');
      toastManager.showUndoToast({
        title: !list
          ? t('savedSuggestions.archivedToastMessage')
          : target === 'archive'
            ? t('savedSuggestions.movedToArchive')
            : t('savedSuggestions.movedToReadLater'),
        undoLabel: t('articleMenu.undo'),
        undoTestID: 'saved-list-undo',
        undoneTitle: t('feedbackTree.undoneTitle'),
        onUndo: () => (list ? moveSavedToList(savedId, list) : deleteSavedSuggestion(savedId)),
      });
      return true;
    };
    return {
      key: 'archive',
      label: !list
        ? t('savedSuggestions.archiveAction')
        : target === 'archive'
          ? t('savedSuggestions.moveToArchive')
          : t('savedSuggestions.moveToReadLater'),
      icon: target === 'archive' ? 'archive' : 'unarchive',
      testID: 'menu-archive',
      run,
    };
  }, [t, list, savedId, save]);
}
