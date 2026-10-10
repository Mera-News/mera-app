/**
 * Publisher identity helpers.
 */

/**
 * Extract a readable domain from a URL as a publisher-name fallback — preserved
 * verbatim from the old CompactPublisherNewsCard, consolidated here so callers
 * share one implementation.
 */
export function extractDomain(url: string): string {
    try {
        const match = url.match(/^https?:\/\/(?:www\.)?([^/]+)/);
        if (match && match[1]) {
            return match[1].replace(/\.(com|org|net|edu|gov|co\.uk|co|io|ai)$/i, '');
        }
        return url;
    } catch {
        return url;
    }
}
