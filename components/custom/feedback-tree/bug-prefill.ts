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

/** The story line, one key per case: a language lead-in differs per locale, so
 *  a blank value cannot be stripped out of the full sentence. */
function storyLine(t: TFunction, { site, countryName: country, languageName: language }: BugPrefillInput): string {
  if (country && language) return t('feedbackTree.menu.prefillStory', { site, country, language });
  if (country) return t('feedbackTree.menu.prefillStoryNoLanguage', { site, country });
  if (language) return t('feedbackTree.menu.prefillStoryNoCountry', { site, language });
  return t('feedbackTree.menu.prefillStorySiteOnly', { site });
}

export function buildBugPrefill(t: TFunction, i: BugPrefillInput): string {
  return [
    t('feedbackTree.menu.prefillIntro'),
    t('feedbackTree.menu.prefillWhat', { reason: i.reason }),
    storyLine(t, i),
    t('feedbackTree.menu.prefillChecked', {
      scorer: t(i.scorer === 'phone' ? 'feedbackTree.menu.scorerPhone' : 'feedbackTree.menu.scorerCloud'),
    }),
  ].join('\n');
}
