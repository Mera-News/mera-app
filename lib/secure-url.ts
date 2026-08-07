/**
 * Transport-security guard for article URLs (defence in depth).
 *
 * The server already excludes insecure articles from every serving path, so in
 * practice nothing reaching this guard should fail it. The rows already ON the
 * device are the gap: a suggestion synced before that server-side filter landed
 * (or restored from a 30-day-old publication-visit snapshot) can still carry an
 * `http://` URL, and opening one hands the reader's traffic to a plaintext
 * connection that any middlebox can read or rewrite.
 *
 * Deliberately narrow: this checks the SCHEME only, and only for the paths that
 * open or share an ARTICLE URL. It is NOT applied to `openInAppBrowser` at
 * large — the native force-update gate feeds it a server-supplied `storeUrl`
 * which is legitimately a store scheme (`itms-apps://`, `market://`), and
 * blanket-blocking that would silently break the update path.
 *
 * Pure — no React Native, no network, never throws.
 */

/**
 * True when `url` is an absolute `https://` URL with a non-empty host.
 *
 * Leading/trailing whitespace is tolerated (feed data is not always clean), but
 * nothing else is: no scheme-relative (`//host`), no `http://`, no `javascript:`
 * or `data:`, no bare host. Anything unparseable is insecure by default.
 */
export function isSecureUrl(url: string | null | undefined): boolean {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    // Host must be present and must not itself start a path/query/fragment.
    // Embedded whitespace is rejected outright — a URL with a raw space or
    // newline in it is either corrupt or a header-splitting attempt.
    if (/\s/.test(trimmed)) return false;
    return /^https:\/\/[^/?#]+/i.test(trimmed);
}

/**
 * The URL when it is safe to open/share, otherwise `null`.
 *
 * Callers use the `null` to render an explicit "link unavailable" state — the
 * point of the guard is that an insecure link reads as unavailable, never as a
 * button that silently does nothing.
 */
export function secureUrlOrNull(url: string | null | undefined): string | null {
    return isSecureUrl(url) ? (url as string).trim() : null;
}
