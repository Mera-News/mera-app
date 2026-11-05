import { getCountryName } from '@/lib/algorithms/country-utils';
import {
    isStarInherited,
    publisherPrefNames,
    resolvePrefLevel,
    type PrefRowLike,
} from '@/lib/algorithms/publication-pref-level';
import { revertSourcePrefChange, setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';
import { observeActive } from '@/lib/database/services/publication-preference-service';
import { fetchPublicationPrefNames, knownSourceNamesForPublisher } from '@/lib/database/services/publisher-source-names';
import logger from '@/lib/logger';
import { toastManager } from '@/lib/toast-manager';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { setNotPreferredWithUndo } from './set-not-preferred';

export interface RowPublisher {
    readonly publisherId: string;
    readonly rawName: string;
    /** Alpha-3; decides whether the star comes from a preferred country. */
    readonly countryCode?: string | null;
    /** The full source set, when the list has it. A search hit does not. */
    readonly sourceNames?: readonly string[];
}

export interface RowCountry {
    readonly alpha2: string;
    readonly alpha3: string;
    /** The English name the scope row stores. */
    readonly label: string;
}

/**
 * Star and Not preferred for a list of rows, on ONE observation of the
 * preference rows (a row per publication would be one per list item). Spread
 * `publisherRow` or `countryRow` onto a `PublicationControlRow`, and mount one
 * `InheritedStarHelp` with `helpCountry` beside the list.
 */
export function usePublicationRowPrefs() {
    const { t } = useTranslation();
    const [rows, setRows] = useState<readonly PrefRowLike[]>([]);
    const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
    const [helpCountry, setHelpCountry] = useState<string | null>(null);
    // A second tap can land before the busy render.
    const running = useRef(new Set<string>());

    useEffect(() => {
        const sub = observeActive().subscribe((next) => setRows(next));
        return () => sub.unsubscribe();
    }, []);

    const run = useCallback(
        async (key: string, write: () => Promise<boolean>) => {
            if (running.current.has(key)) return;
            running.current.add(key);
            setBusy(new Set(running.current));
            try {
                if (!(await write())) toastManager.showInfo(t('you.sources.saveError'));
            } catch (error) {
                logger.captureException(error, { tags: { component: 'usePublicationRowPrefs', method: 'write' } });
                toastManager.showInfo(t('you.sources.saveError'));
            } finally {
                running.current.delete(key);
                setBusy(new Set(running.current));
            }
        },
        [t],
    );

    const publisherRow = (p: RowPublisher) => {
        const names = publisherPrefNames(p.sourceNames ?? [], knownSourceNamesForPublisher(p.publisherId) ?? [], p.rawName);
        const level = resolvePrefLevel(rows, names);
        const inherited = isStarInherited(rows, names, p.countryCode);
        const country = inherited && p.countryCode ? getCountryName(p.countryCode) : null;
        // Fetched before each write, never from the row: a search hit's names are
        // only those that matched, and a preference under part of them reaches
        // part of the publication's news. A throw refuses the write.
        const allNames = async () => {
            try {
                return await fetchPublicationPrefNames({
                    publisherId: p.publisherId,
                    publisherName: p.rawName,
                    sourceNames: p.sourceNames,
                });
            } catch {
                return null;
            }
        };
        return {
            starred: level === 'prioritised',
            inheritedFrom: country,
            notPreferred: level === 'muted',
            busy: busy.has(p.publisherId),
            onStar: () => {
                if (country) {
                    setHelpCountry(country);
                    return;
                }
                void run(p.publisherId, async () => {
                    const all = await allNames();
                    if (!all) return false;
                    const target = { kind: 'publisher' as const, names: all };
                    return (await setSourcePrefFromUi(target, level === 'prioritised' ? 'none' : 'prioritised')).applied;
                });
            },
            onNotPreferred: (shownAs: string) => {
                void run(p.publisherId, async () => {
                    const all = await allNames();
                    if (!all) return false;
                    if (level !== 'muted') return setNotPreferredWithUndo(all, shownAs, t);
                    return (await setSourcePrefFromUi({ kind: 'publisher', names: all }, 'none')).applied;
                });
            },
        };
    };

    const countryRow = (c: RowCountry) => {
        // No names: the question is only whether the country itself is preferred.
        const starred = isStarInherited(rows, [], c.alpha3);
        const key = `country:${c.alpha3}`;
        const target = { kind: 'country' as const, countryAlpha2: c.alpha2, label: c.label };
        return {
            starred,
            countryName: c.label,
            busy: busy.has(key),
            onStar: (shownAs: string) => {
                void run(key, async () => {
                    if (!starred) return (await setSourcePrefFromUi(target, 'prioritised')).applied;
                    const res = await setSourcePrefFromUi(target, 'none');
                    if (res.applied) {
                        toastManager.showUndoToast({
                            title: t('you.sources.countryCleared', { country: shownAs }),
                            undoLabel: t('articleMenu.undo'),
                            undoTestID: 'country-clear-undo',
                            undoneTitle: t('feedbackTree.undoneTitle'),
                            onUndo: () => revertSourcePrefChange(res),
                        });
                    }
                    return res.applied;
                });
            },
        };
    };

    const closeHelp = useCallback(() => setHelpCountry(null), []);
    return { publisherRow, countryRow, helpCountry, closeHelp };
}
