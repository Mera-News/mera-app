# Tutorial animations

**Nothing here today, and that is the shipped state — not a gap.**

The tutorials module renders every one of its ~65 slides through
`components/custom/tutorials/ScenePlaceholder.tsx`: five hand-built Reanimated +
SVG scene kinds (`logo`, `icon`, `cards`, `orbit`, `steps`). No animation
runtime package is installed, no native module is linked, and no pod install or
binary rebuild is involved — which is precisely why the whole module ships over
the air.

This directory exists so that adding animations later is a small, contained
change rather than a re-plumb.

## The contract

| | |
|---|---|
| Filename | `<chapter>-<slide>.json` — exactly `animationIdFor()` in `lib/tutorials/keys.ts` |
| Format | bodymovin `.json`. **Not** `.lottie` — that needs a Metro `assetExts` change and a dotLottie runtime |
| Canvas | 1000 × 1000, square |
| Background | transparent — the app is `#000`, dark-only |
| Loop | 2–4s, seamless |
| Accent | `rgb(231, 138, 83)` (primary-400, `TUTORIAL_ACCENT`) |
| Size | ≤ 150 KB each |
| Contents | vector only — no embedded rasters, no expressions |

A scene block is `SCENE_HEIGHT` (200pt) tall and `contentFit`-style contained,
so anything near the canvas edges will be letterboxed. Keep the subject inside
the middle ~70%.

## Adding one

1. Install an animation runtime and re-cut the binary. This is the only step
   that is not OTA-able, and it is why nothing here is wired up yet.
2. Uncomment the render branch in
   `components/custom/tutorials/SceneView.tsx` (it is written out in full in a
   comment there) together with its import.
3. Drop `<chapter>-<slide>.json` into this directory.
4. Uncomment that id's line in
   `components/custom/tutorials/animation-registry.ts`. **An entry may exist
   there only once its file is on disk** — Metro resolves `require()` at bundle
   time, so an entry pointing at a missing file is a build error no runtime
   guard can catch. That trap is the entire reason the registry is one file.

Nothing else changes, at any N from 0 to 65. Slides with no entry keep their
placeholder, and the two can coexist indefinitely.

⚠️ `lib/tutorials/__tests__/chapters.test.ts` asserts that no *uncommented* line
under `components/custom/tutorials/` or `lib/tutorials/` mentions an animation
package, and that `package.json` has no such dependency. Step 1 above is what
retires that assertion; do not weaken it before then.

## Commission order

One hero per chapter — the chapter's opening slide. The other ~53 slides read
correctly on their placeholders and can be backfilled in any order, or never.

| # | Chapter | Hero id |
|---|---|---|
| 1 | welcome | `welcome-what` |
| 2 | facts | `facts-a-fact-is` |
| 3 | feed | `feed-two-lists` |
| 4 | teaching | `teaching-two-thumbs` |
| 5 | privacy | `privacy-stays-on-phone` |
| 6 | following | `following-what-it-is` |
| 7 | explore | `explore-unscored-on-purpose` |
| 8 | sources | `sources-where-it-lives` |
| 9 | filters | `filters-three-shelves` |
| 10 | signal | `signal-the-dial` |
| 11 | chat | `chat-where-mera-is` |
| 12 | protocol | `protocol-one-screen` |

Each hero's brief is its slide's headline and body in
`lib/locales/en.json → tutorials.chapters.<slug>.slides.<id>`, plus the
placeholder kind already chosen for it in `lib/tutorials/chapters.ts` — that
kind is the composition the copy was written against, so an animation replacing
it should read as the same idea, moving better.

⚠️ Chapter `welcome` is the pre-auth chapter and **must never show the mera
logo** (explicit user instruction, asserted in `chapters.test.ts`). That applies
to a commissioned animation exactly as it applies to a placeholder.
