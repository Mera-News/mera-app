// Persona-audit display map — action_type / source → icon + i18n label key.
//
// Pure (RN-free apart from the MaterialIcons glyph type). Each persona-mutation
// action_type (see lib/news-harness/persona-management/action-names.ts) maps to
// a leading icon + a personaAudit.actionLabels.* key; each change-log `source`
// maps to a personaAudit.sources.* chip label. Unknown ids fall back to a
// generic history icon and their raw string, so a new action type still renders
// (with the raw id) instead of crashing the audit list.

import type { MaterialIcons } from '@expo/vector-icons';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import type { PersonaChangeLogSource } from '@/lib/database/models/PersonaChangeLog';

type GlyphName = keyof typeof MaterialIcons.glyphMap;

export interface ActionDisplay {
    readonly icon: GlyphName;
    /** i18n key under `personaAudit.actionLabels`. */
    readonly labelKey: string;
}

const ACTION_DISPLAY: Record<string, ActionDisplay> = {
    [ACTION_NAMES.SET_TOPIC_WEIGHT]: { icon: 'tune', labelKey: 'setTopicWeight' },
    [ACTION_NAMES.SET_FACT_WEIGHT]: { icon: 'tune', labelKey: 'setFactWeight' },
    [ACTION_NAMES.SET_LOCATION_WEIGHT]: { icon: 'place', labelKey: 'setLocationWeight' },
    [ACTION_NAMES.ADD_TOPIC]: { icon: 'add-circle-outline', labelKey: 'addTopic' },
    [ACTION_NAMES.ADD_NEGATIVE_TOPIC]: { icon: 'block', labelKey: 'addNegativeTopic' },
    [ACTION_NAMES.RETIRE_TOPIC]: { icon: 'remove-circle-outline', labelKey: 'retireTopic' },
    [ACTION_NAMES.SUPPRESS_TOPIC]: { icon: 'visibility-off', labelKey: 'suppressTopic' },
    [ACTION_NAMES.ADD_SUPPRESSION]: { icon: 'visibility-off', labelKey: 'addSuppression' },
    [ACTION_NAMES.SET_HIGH_PRIORITY]: { icon: 'flag', labelKey: 'setHighPriority' },
    [ACTION_NAMES.SET_PUBLICATION_PREF]: { icon: 'article', labelKey: 'setPublicationPref' },
    [ACTION_NAMES.NUDGE_SUBSCRIBE_PUBLICATION]: { icon: 'notifications-active', labelKey: 'nudgeSubscribePublication' },
    [ACTION_NAMES.NUDGE_BROWSE_RELATED]: { icon: 'explore', labelKey: 'nudgeBrowseRelated' },
    [ACTION_NAMES.REASSIGN_TOPIC]: { icon: 'swap-horiz', labelKey: 'reassignTopic' },
    [ACTION_NAMES.MERGE_FACTS]: { icon: 'merge-type', labelKey: 'mergeFacts' },
    [ACTION_NAMES.HYGIENE_DELETE_FACT]: { icon: 'delete-sweep', labelKey: 'hygieneDeleteFact' },
    [ACTION_NAMES.ADD_LOCATION]: { icon: 'add-location-alt', labelKey: 'addLocation' },
    [ACTION_NAMES.DELETE_LOCATION]: { icon: 'wrong-location', labelKey: 'deleteLocation' },
    [ACTION_NAMES.REVERT_CHANGE]: { icon: 'undo', labelKey: 'revertChange' },
};

const FALLBACK: ActionDisplay = { icon: 'history', labelKey: 'unknown' };

export function actionDisplay(actionType: string): ActionDisplay {
    return ACTION_DISPLAY[actionType] ?? FALLBACK;
}

/**
 * `revert_change` rows are the audit trail of an undo and are not themselves
 * invertible (the service has no inverse for them). Everything else is offered
 * a Revert affordance; the service throws for action types it can't yet invert
 * and the screen surfaces that as a toast.
 */
export function isRevertible(actionType: string): boolean {
    // `revert_change` rows have no inverse. Hygiene fact deletes are destructive
    // (the fact + its topics are gone) — there is nothing to restore, so no
    // Revert affordance is offered. Location add/delete rows are audit-only this
    // wave (add/delete are managed directly from the locations screen; the
    // change-log service has no inverse for them).
    return (
        actionType !== ACTION_NAMES.REVERT_CHANGE &&
        actionType !== ACTION_NAMES.HYGIENE_DELETE_FACT &&
        actionType !== ACTION_NAMES.ADD_LOCATION &&
        actionType !== ACTION_NAMES.DELETE_LOCATION
    );
}

/** i18n key under `personaAudit.sources` for a change-log source. */
export function sourceLabelKey(source: PersonaChangeLogSource | string): string {
    switch (source) {
        case 'nudge':
        case 'chat':
        case 'feedback':
        case 'digest':
        case 'slider':
        case 'migration':
        case 'user':
            return source;
        default:
            return 'unknown';
    }
}
