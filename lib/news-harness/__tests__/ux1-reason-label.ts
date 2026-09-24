// The ux1 reason-prompt edit, as a reversible delta, so the archive tests can
// still prove "shipped = archive + named changes, and nothing else".
//
// ux1 replaced the low-score example that used the rubric label
// "foreign-domestic" (the model copied it into a reader's note) and added one
// paragraph telling the model never to name the rules. `undoUx1ReasonLabelRule`
// takes both back out; applied to the shipped prompt it must yield the text the
// archived arms were built from.

import { RULE_NAME_BAN } from '../prompts/prompts';

export const UX1_NEW_EXAMPLE =
    "\"Bulgaria's digital-ID policy is a Bulgarian domestic matter; no tie to your country.\"";
export const UX1_OLD_EXAMPLE =
    "\"Bulgaria's digital-ID policy is foreign-domestic; no tie to your country.\"";
export const UX1_LABEL_RULE = `\n\n${RULE_NAME_BAN}`;

export function undoUx1ReasonLabelRule(prompt: string): string {
    return prompt.replace(UX1_LABEL_RULE, '').replace(UX1_NEW_EXAMPLE, UX1_OLD_EXAMPLE);
}

/** The headline reason prompt got the same ban as its own block (ux1, K-3),
 *  between its task and its rules. This takes it back out, so the archive
 *  arms still compare against the text they were built from. */
export function undoUx1HeadlineRuleBan(prompt: string): string {
    return prompt.replace(`\n\n${RULE_NAME_BAN}`, '');
}
