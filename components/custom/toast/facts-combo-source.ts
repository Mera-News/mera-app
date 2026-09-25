import { Q } from '@nozbe/watermelondb';
import type { Observable } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';

/**
 * How many `topic_combo` inference jobs are pending or running, live.
 *
 * TEMPORARY BODY. The owner of this count is the data area's
 * `observeActiveComboJobCount()` in `lib/database/services/combo-pass-service.ts`
 * (ux2 P4). Until that file exists this seam queries the table itself, because
 * a `require` of a missing module fails Metro's bundle for the whole app. Once
 * it lands, this function becomes a one-line delegate to it (keep the
 * `distinctUntilChanged`), and the controller and its tests do not change.
 *
 * Read from the DATABASE, so the progress toast survives a kill: a relaunch
 * that finds the pass still queued shows it again on the first emission. The
 * database is required at CALL time: `lib/database/index.ts` builds its SQLite
 * adapter at import time, and this module sits under the root layout.
 */
export function observeActiveComboJobCount(): Observable<number> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const database = (require('@/lib/database') as typeof import('@/lib/database')).default;
    return database
        .get('inference_jobs')
        .query(Q.where('job_type', 'topic_combo'), Q.where('status', Q.oneOf(['pending', 'running'])))
        .observeCount()
        .pipe(distinctUntilChanged());
}
