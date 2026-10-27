// Prefill for the bug report. The input type is the privacy boundary: it has
// no field for an article id, URL, title, fact text or account, so none can
// be passed through. Pure; the caller derives `scorer` from the processing mode.
import type { TFunction } from 'i18next';

export interface BugPrefillInput {
  reason: string;
  site: string;
  countryName: string;
  languageName: string;
  scorer: 'phone' | 'cloud';
}

export function buildBugPrefill(t: TFunction, i: BugPrefillInput): string {
  return [
    t('feedbackTree.menu.prefillIntro'),
    t('feedbackTree.menu.prefillWhat', { reason: i.reason }),
    t('feedbackTree.menu.prefillStory', { site: i.site, country: i.countryName, language: i.languageName }),
    t('feedbackTree.menu.prefillChecked', {
      scorer: t(i.scorer === 'phone' ? 'feedbackTree.menu.scorerPhone' : 'feedbackTree.menu.scorerCloud'),
    }),
  ].join('\n');
}
