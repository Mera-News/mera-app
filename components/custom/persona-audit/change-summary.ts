// One change-log row in words, in the app language, from its action type and
// the data the row stores (`action_json`). Rows written before this existed
// render the same way: the stored English `summary` column is never shown.
//
// Most rows store only `targetId`; the screen loads what those ids name
// (persona-change-log-service.getChangeTargets) and passes it in. When a target
// is gone (a deleted fact or place), the row reads as its action label.

import { alpha3ToAlpha2, countryNameForAlpha2 } from '@/components/custom/locations/location-display';
import type { ChangeTarget } from '@/lib/database/services/persona-change-log-service';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import type en from '@/lib/locales/en.json';
import type { TFunction } from 'i18next';
import { actionDisplay } from './action-display';

type Translate = TFunction<'translation'>;

export interface ChangeRow {
    readonly id: string;
    readonly actionType: string;
    readonly actionJson: string;
}

export interface ChangeContext {
    readonly targets: ReadonlyMap<string, ChangeTarget>;
    /** A publication name as the reader sees it (publication-display-store). */
    readonly publication: (name: string) => string;
    /** The loaded rows, so an undo can name the change it undid. */
    readonly rowsById: ReadonlyMap<string, ChangeRow>;
}

type Action = Record<string, unknown>;
type SummaryKey = Exclude<keyof typeof en.personaAudit.summary, 'undone'>;

function parse(json: string): Action {
    try {
        const v = JSON.parse(json);
        return v && typeof v === 'object' ? (v as Action) : {};
    } catch {
        return {};
    }
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function placeName(city: unknown, countryCode: unknown): string {
    return str(city) || countryNameForAlpha2(str(countryCode));
}

function targetName(target: ChangeTarget | undefined): string {
    if (!target) return '';
    return 'text' in target ? target.text.trim() : placeName(target.city, target.countryCode);
}

/** The row's action label, e.g. "Removed topic": the fallback when nothing can be named. */
export function actionLabel(t: Translate, actionType: string): string {
    return t(`personaAudit.actionLabels.${actionDisplay(actionType).labelKey}` as never);
}

export function changeSummary(t: Translate, row: ChangeRow, ctx: ChangeContext): string {
    const a = parse(row.actionJson);
    const id = str(a.targetId);
    const label = actionLabel(t, row.actionType);
    const named = (key: SummaryKey, name: string) => (name ? t(`personaAudit.summary.${key}`, { name }) : label);
    const lookedUp = targetName(ctx.targets.get(id));

    switch (row.actionType) {
        case ACTION_NAMES.ADD_TOPIC:
            return named('added', str(a.text) || lookedUp);
        case ACTION_NAMES.ADD_NEGATIVE_TOPIC:
            return named('muted', str(a.text) || lookedUp);
        case ACTION_NAMES.RETIRE_TOPIC:
            return named('removed', lookedUp);
        case ACTION_NAMES.SET_TOPIC_WEIGHT:
        case ACTION_NAMES.SET_FACT_WEIGHT:
        case ACTION_NAMES.SET_LOCATION_WEIGHT: {
            // A fact's null weight is the 1.0 baseline (mutation-rails nudgeFactWeight).
            const before = typeof a.before === 'number' ? a.before : 1;
            const after = typeof a.after === 'number' ? a.after : before;
            return named(after >= before ? 'countsMore' : 'countsLess', lookedUp);
        }
        case ACTION_NAMES.SET_HIGH_PRIORITY:
            return named(a.after === true ? 'pinned' : 'unpinned', lookedUp);
        case ACTION_NAMES.ADD_SUPPRESSION:
            return named('notInterested', lookedUp || str(a.value));
        case ACTION_NAMES.RETIRE_SUPPRESSION:
            return named('showingAgain', str(a.pattern) || lookedUp);
        case ACTION_NAMES.SET_PUBLICATION_PREF: {
            // targetId is the publication NAME (the app keys publications by name).
            const name = id ? ctx.publication(id) : '';
            if (!name) return label;
            if (a.after === 'boost') return named('moreFrom', name);
            if (a.after === 'deprioritize') return t('articleMenu.fewerFrom', { source: name });
            if (a.after === 'mute') return named('muted', name);
            return named('cleared', name);
        }
        case ACTION_NAMES.SET_SOURCE_SCOPE_PREF: {
            // targetId is '{scopeKind}:{alpha3}'; only 'country' exists.
            const alpha3 = id.startsWith('country:') ? id.slice('country:'.length) : '';
            const name = str(a.label) || countryNameForAlpha2(alpha3ToAlpha2(alpha3));
            if (a.after === 'boost') return named('moreSourcesFrom', name);
            if (a.after === 'deprioritize') return named('fewerSourcesFrom', name);
            return named('clearedSourcesFrom', name);
        }
        case ACTION_NAMES.ADD_LOCATION:
            return named('added', placeName(a.city, a.countryCode) || lookedUp);
        case ACTION_NAMES.DELETE_LOCATION:
            return named('removed', placeName(a.city, a.countryCode) || lookedUp);
        case ACTION_NAMES.DISCARD_FACT:
        case ACTION_NAMES.HYGIENE_DELETE_FACT:
            return named('removed', str(a.statement) || lookedUp);
        case 'migrate_fact':
            return named('carriedOver', lookedUp);
        case ACTION_NAMES.REVERT_CHANGE: {
            const undone = ctx.rowsById.get(id);
            const change = undone ? changeSummary(t, undone, ctx) : actionLabel(t, str(a.revertedActionType));
            return t('personaAudit.summary.undone', { change });
        }
        default:
            return label;
    }
}
