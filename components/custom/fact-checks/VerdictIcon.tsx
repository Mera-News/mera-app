// The shield that stands in front of a verdict, chosen by TONE.
//
// Keyed on `FactCheckTone` rather than on the verdict itself, deliberately.
// `describeVerdict` already collapses six verdicts onto three tones, and that
// collapse is where the editorial judgement lives — "disputed", "unsupported"
// and "mixed" all mean "there is a problem here" and must not shade into three
// different-looking answers. Keying on the verdict would let the icon and the
// colour disagree, which is the class of bug this whole panel keeps having:
// two signals about the same finding, saying different things.
//
// It also means the article panel and the compact Dashboard card cannot drift.
// They render the same finding at different sizes, and both read this.
//
// NOT keyed on the ORGANISATION's verdict. When a fact-checking organisation
// has published, its rating is a verbatim quote on its own scale ("Pants on
// Fire", "Missing context") and is never mapped onto our five values — so there
// is no tone to derive from it and no shield is drawn for it. See
// `FactCheckSources`.

import React from 'react';
import type { FactCheckTone } from '@/lib/fact-check/fact-check-state';
import { ShieldAlert, ShieldCheck, ShieldQuestionMark } from 'lucide-react-native';

/** `ShieldQuestionMark`, not `ShieldQuestion`: lucide renamed it, and the old
 *  name does not exist in 0.563.x — importing it fails at module load, not at
 *  render, so it would take the whole screen with it. */
const TONE_ICON = {
    positive: ShieldCheck,
    caution: ShieldAlert,
    neutral: ShieldQuestionMark,
} as const;

/**
 * The dark-ramp resolution of the SAME tokens `TONE_CLASSES` uses for the text
 * beside the shield — `success-400`, `warning-400`, `outline-300` (which is what
 * `gray-300` resolves to). Literals because lucide icons take a `color` prop,
 * not a className, which is the established idiom for direct lucide use here
 * (see CardActionBar). This app is dark-mode only, so there is one ramp to
 * resolve against.
 */
const TONE_COLOR: Record<FactCheckTone, string> = {
    positive: 'rgb(52, 131, 82)',
    caution: 'rgb(231, 120, 40)',
    neutral: 'rgb(115, 116, 116)',
};

export interface VerdictIconProps {
    readonly tone: FactCheckTone;
    readonly size?: number;
    /** Defaults to the tone's own colour. Pass one only to match a surface that
     *  already diverges. */
    readonly color?: string;
}

/**
 * `positive` → verified, `caution` → an issue was found, `neutral` → nothing
 * could be established either way.
 *
 * The colour defaults to the tone's own, resolved from the same tokens
 * `TONE_CLASSES` uses for the text beside it, so the shield cannot end up a
 * different colour from the words it introduces.
 */
export const VerdictIcon: React.FC<VerdictIconProps> = ({ tone, size = 16, color }) => {
    const Icon = TONE_ICON[tone];
    return <Icon size={size} strokeWidth={2} color={color ?? TONE_COLOR[tone]} />;
};

export default VerdictIcon;
