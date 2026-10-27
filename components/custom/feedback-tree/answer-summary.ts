// The toast after the sheet closes: how many answers changed the profile
// (config) and how many were Mera's mistakes (system). Source answers alone
// read as a plain "saved". Pure.
import type { TFunction } from 'i18next';
import type { FeedbackCause } from '@/lib/news-harness/core/types';

export function summaryToast(t: TFunction, answers: readonly { cause: FeedbackCause }[]): string | null {
  if (answers.length === 0) return null;
  const changes = answers.filter((a) => a.cause === 'config').length;
  const mistakes = answers.filter((a) => a.cause === 'system').length;
  // "1 change saved · 1 mistake noted": each half its own plural key.
  if (changes && mistakes) {
    return t('feedbackTree.menu.toastBoth', {
      changes: t('feedbackTree.menu.toastChanges', { count: changes }),
      mistakes: t('feedbackTree.menu.toastMistakeCount', { count: mistakes }),
    });
  }
  if (changes) return t('feedbackTree.menu.toastChanges', { count: changes });
  if (mistakes) return t('feedbackTree.menu.toastMistakes', { count: mistakes });
  return t('feedbackTree.menu.toastSaved');
}
