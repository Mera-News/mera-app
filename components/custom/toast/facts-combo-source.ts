import type { Observable } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';

/**
 * How many `topic_combo` inference jobs are pending or running, live: a thin
 * delegate to the data area's `observeActiveComboJobCount()`
 * (`lib/database/services/combo-pass-service.ts`), which owns that query. Never
 * query `inference_jobs` here.
 *
 * Read from the DATABASE, so the progress toast survives a kill: a relaunch
 * that finds the pass still queued shows it again on the first emission. The
 * service is required at CALL time: it reaches `lib/database/index.ts`, which
 * builds its SQLite adapter at import time, and this module sits under the root
 * layout. `distinctUntilChanged` because the controller acts only on edges.
 */
export function observeActiveComboJobCount(): Observable<number> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const service = require('@/lib/database/services/combo-pass-service') as typeof import('@/lib/database/services/combo-pass-service');
    return service.observeActiveComboJobCount().pipe(distinctUntilChanged());
}
