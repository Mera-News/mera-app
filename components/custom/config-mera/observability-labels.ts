// Human-friendly labels for the Observability screen.
//
// The screen surfaces raw engineering identifiers (snake_case table names,
// camelCase store keys, SCREAMING_SNAKE enums). These maps translate them into
// plain language for non-technical users. Anything not explicitly mapped falls
// through to `humanizeKey`, a best-effort Title-Case of the raw identifier.
//
// Kept as plain English constants (not i18n) — consistent with the hardcoded
// 'Observability' entry title; the raw drill-down remains an advanced view.

// ─── DB tables ───────────────────────────────────────────────────────────────

export const TABLE_LABELS: Record<string, { label: string; description?: string }> = {
    article_suggestions: { label: 'Article suggestions', description: 'News matched to your interests' },
    article_suggestion_facts: { label: 'Suggestion reasons', description: 'Why each article was picked' },
    publication_visits: { label: 'Publications you’ve read', description: 'Sources you’ve opened' },
    facts: { label: 'Things Mera knows about you', description: 'What shapes your feed' },
    user_personas: { label: 'Your profile', description: 'Your on-device profile' },
    scheduler_jobs: { label: 'Background tasks', description: 'Work Mera does behind the scenes' },
    inference_jobs: { label: 'AI jobs', description: 'On-device AI work' },
};

// ─── Scheduler tasks (taskName → displayName) ────────────────────────────────

export const TASK_LABELS: Record<string, string> = {
    'feed-sync': 'Feed Sync',
    'inference-recover': 'Inference Recovery',
    'apollo-cache-evict': 'Apollo Cache Eviction',
    'push-token-check': 'Push Token Check',
    'data-cleanup': 'Data Cleanup',
};

// ─── Status strings ──────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<string, string> = {
    idle: 'Idle',
    running: 'Running',
    completed: 'Done',
    done: 'Done',
    failed: 'Failed',
    pending: 'Waiting',
    stale: 'Stuck',
    cancelled: 'Cancelled',
    retrying: 'Retrying',
};

// ─── Field (KV key) labels for the visible Feed/Protocol/System rows ─────────

export const FIELD_LABELS: Record<string, string> = {
    articleCount: 'Articles',
    relevantArticleCount: 'Relevant articles',
    unscoredCount: 'Not yet scored',
    lastSyncAt: 'Last updated',
    processingMode: 'Mode',
    downloadProgress: 'Download',
    isProcessing: 'Working now',
    network: 'Connection',
    db: 'Storage',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Best-effort humanization of a raw identifier when no explicit label exists.
 * Strips common technical suffixes, splits snake_case / camelCase, and
 * Title-Cases the first word (e.g. `matched_topic_texts_json` → "Matched topic texts").
 */
export function humanizeKey(key: string): string {
    const cleaned = key
        .replace(/_json$/i, '')
        .replace(/_en$/i, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toLowerCase();
    if (!cleaned) return key;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Friendly label for a DB table name (used by both the summary and detail screens). */
export function tableLabel(name: string): string {
    return TABLE_LABELS[name]?.label ?? humanizeKey(name);
}

/** Friendly status label, falling back to a Title-Cased version of the raw status. */
export function statusLabel(status: string | null | undefined): string {
    if (!status) return 'Idle';
    return STATUS_LABELS[status] ?? humanizeKey(status);
}

/** Humanize a raw value string shown in the Feed/Protocol/System tables. */
export function humanizeValue(value: string): string {
    switch (value) {
        case 'true': return 'Yes';
        case 'false': return 'No';
        case 'CLOUD': return 'Cloud';
        case 'ON_DEVICE': return 'On device';
        case 'connected': return 'Online';
        case 'offline': return 'Offline';
        case 'ready': return 'Ready';
        case 'not ready': return 'Not ready';
        default: return value;
    }
}
