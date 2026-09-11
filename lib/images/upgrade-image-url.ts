// upgrade-image-url — rewrite a publisher image URL to ask the same host for a
// larger rendition of the SAME image.
//
// Why this exists: 42% of the images our feeds serve are below one device pixel
// of the 192pt hero on a 3x phone, and the publisher almost always serves a
// bigger original one string substitution away. Measured live (see the pass
// rates below), one URL per host across 90 hosts:
//
//   height < 576px   38/90  (42%)
//   median 675  p25 410  p75 900  min 51  max 4000
//
// This is a pure, total function. It never throws, never fetches, and returns
// its INPUT BY REFERENCE when no rule applies, so a caller can cheap-compare
// `upgraded === original` to know whether a rewrite happened.
//
// THE RULE FOR ADDING A RULE: ship only with a recorded live pass rate, taken
// by fetching the original AND the rewrite in the same run and decoding real
// pixel dimensions from the image header. A rule that looks obviously right can
// fail on every host it matches — the rejected R5 below matched 18 URLs across
// 3 hosts and returned 404, 403, 403.

/** Hero is `h-48` (192pt) on a ~370pt card. */
export const HERO_TARGET_PX = 1200;
/** Compact row is `w-1/4` (~92pt). */
export const COMPACT_TARGET_PX = 400;

/**
 * Below this target we do not apply BINARY rules (R1, R4). They jump straight
 * to the original with no size control, so on a compact row they would pull a
 * multi-megapixel image to fill 92pt.
 */
const BINARY_RULE_MIN_TARGET_PX = 800;

/**
 * Query-string signatures. Touching any of these invalidates the signature and
 * the CDN answers 401/403 instead of an image.
 *
 * `sign` and `auth` are here because a live probe found them, not by analogy:
 * `media.ouest-france.fr` carries `sign=` and 403s on a width change, and the
 * Arc `resizer/v2` hosts (`nacion.com`, `prensa.com`) carry `auth=` computed
 * over the whole query string.
 */
const SIGNED_QUERY =
  /[?&](s|sig|sign|signature|auth|hmac|hash|token|X-Amz-Signature|Expires|Key-Pair-Id)=/i;

/**
 * Path-embedded HMAC, e.g.
 * `s2-ge.glbimg.com/R5J6vGb_jcQUK9mh9rSYCFHqXZo=/i.s3.glbimg.com/...`.
 * Stripping a size suffix underneath one of these invalidates the path
 * signature: measured 1170x650 -> HTTP 400.
 */
const SIGNED_PATH = /\/[A-Za-z0-9_-]{16,}=+\//;

/**
 * A filename that already carries a crop spec BEFORE the size suffix is a CDN
 * render path, not a WordPress rendition, and the bare name does not exist.
 * Measured: `images.cdn.nos.nl/.../0x100x1600x900-1024x576.webp` -> 404.
 */
const CROP_SPEC_NAME = /\/\d+x\d+x\d+x\d+-\d{2,4}x\d{2,4}\.(?:jpe?g|png|webp)(?:\?|$)/i;

function declaredWidth(url: string): number | null {
  const m = url.match(/[?&](?:width|w)=(\d{2,5})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function declaredHeight(url: string): number | null {
  const m = url.match(/[?&](?:height|h)=(\d{2,5})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

interface UpgradeRule {
  id: string;
  /** Jumps to the original with no size control, so hero-only. */
  binary: boolean;
  test: (url: string) => boolean;
  rewrite: (url: string, targetPx: number) => string;
}

const RULES: UpgradeRule[] = [
  {
    // Live: 11/12 hosts improved, 1 unchanged, 0 broken.
    // beninwebtv.com 768x576 -> 1429x1072; www.alphatv.gr 300x200 -> 1200x800;
    // www.igbo.org 300x117 -> 1559x608.
    id: 'R1-wordpress-suffix',
    binary: true,
    test: (u) => /-\d{2,4}x\d{2,4}\.(?:jpe?g|png|webp)(?:\?|$)/i.test(u) && !CROP_SPEC_NAME.test(u),
    rewrite: (u) => u.replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp))/i, '$1'),
  },
  {
    // Photon. Must run BEFORE R2: a Photon URL can carry both `resize` and `w`.
    // The host test is anchored on the scheme because `i0.wp.com` is preceded by
    // `//`, not by a dot — a `(^|\.)` form silently matches nothing.
    // The comma is often percent-encoded in RSS (`resize=696%2C310`).
    // Live: 4/4 improved, 0 broken. maurice-info.mu 150x75 -> 750x375.
    id: 'R3-photon-resize',
    binary: false,
    test: (u) =>
      /^https?:\/\/i\d\.wp\.com\//i.test(u) && /[?&]resize=\d+(?:(?:,|%2C)\d+)?/i.test(u),
    rewrite: (u, target) => u.replace(/([?&])resize=\d+(?:(?:,|%2C)\d+)?/i, `$1w=${target}`),
  },
  {
    // Live: 4/5 improved, 1 correctly skipped by raise-only, 0 broken.
    // static.bonniernews.se 600x400 -> 1200x800; img-msp-prod.nzz.ch 200x200 -> 1200x1200.
    id: 'R2-query-width-raise',
    binary: false,
    test: (u) => declaredWidth(u) !== null,
    rewrite: (u, target) => {
      const w = declaredWidth(u);
      if (w === null || w >= target) return u;
      const h = declaredHeight(u);
      let out = u.replace(/([?&])(width|w)=(\d{2,5})\b/i, `$1$2=${target}`);
      if (h !== null) {
        // Raising `width` while `height` stays pinned changes the CROP, not the
        // size: measured nacion.com 722x406 -> 1200x406, an aspect change under
        // a `cover` hero. Scale both by the same factor.
        const scaled = Math.round(h * (target / w));
        out = out.replace(/([?&])(height|h)=(\d{2,5})\b/i, `$1$2=${scaled}`);
      }
      return out;
    },
  },
  {
    // Live: 8/8 improved, 0 broken, every one of them 72x72 at source.
    // Covers both the bare `/s72-c/` form and the `/s72-w772-h557-c/` form.
    id: 'R4-blogger-size-segment',
    binary: true,
    test: (u) =>
      /\/s\d{2,5}(?:-[a-z0-9-]+)?\//i.test(u) && /(?:blogspot|googleusercontent)/i.test(u),
    rewrite: (u) => u.replace(/\/s\d{2,5}(?:-[a-z0-9-]+)?\//i, '/s1600/'),
  },
];

// REJECTED, do not re-add without a live pass rate:
//   R5 `/thumbnails/` -> `/images/`. Guessing a sibling path segment. Matched 18
//   URLs across 3 hosts and returned 404, 403, 403. Zero live passes.

/**
 * Returns a URL for a larger rendition of the same image, or the input itself
 * (by reference) when no validated rule applies.
 *
 * Never throws: malformed input comes back unchanged.
 */
export function upgradeImageUrl(
  url: string | null | undefined,
  targetPx: number,
): string {
  if (typeof url !== 'string' || url.length === 0) return url ?? '';
  try {
    if (SIGNED_QUERY.test(url) || SIGNED_PATH.test(url)) return url;
    const declared = declaredWidth(url);
    if (declared !== null && declared >= targetPx) return url; // raise-only
    for (const rule of RULES) {
      if (rule.binary && targetPx < BINARY_RULE_MIN_TARGET_PX) continue;
      if (!rule.test(url)) continue;
      const rewritten = rule.rewrite(url, targetPx);
      return rewritten === url ? url : rewritten;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Which rule (or skip reason) applies. Exported for the observability table and
 * for tests; the render path only needs `upgradeImageUrl`.
 */
export function matchingRuleId(url: string, targetPx: number): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  if (SIGNED_QUERY.test(url) || SIGNED_PATH.test(url)) return 'skipped-signed';
  const declared = declaredWidth(url);
  if (declared !== null && declared >= targetPx) return 'skipped-already-large';
  for (const rule of RULES) {
    if (rule.binary && targetPx < BINARY_RULE_MIN_TARGET_PX) continue;
    if (rule.test(url)) return rule.id;
  }
  return null;
}
