# Animations

Eighteen bodymovin files: twelve tutorial chapter heroes and six feed
processing stages. They are agent-authored, written straight against the
bodymovin schema, and every one of them is gated by a script before it lands
(see "Validating one", below).

**The runtime is in the binary.** `lottie-react-native ~7.3.4` was banked in
`baff527` and that commit is an ancestor of the 1.3.1 version bump, so every
1.3.1 binary carries the native module and this whole directory ships over the
air. Prove it the same way before trusting it again, because a binary cut
BEFORE the banking would crash on an OTA that references Lottie:

```
git log -S'lottie-react-native' --format=%h -- package.json | tail -1
git merge-base --is-ancestor <that hash> <the binary's commit> ; echo $?
```

Exit 0 or it is not in that binary. `runtimeVersion` is `{policy: 'appVersion'}`,
so one channel serves every 1.3.1 device.

## The contract

| | |
|---|---|
| Filename, tutorials | `<chapter>-<slide>.json` — exactly `animationIdFor()` in `lib/tutorials/keys.ts` |
| Filename, processing | `processing-<stageId>.json` — the six ids in `components/custom/processing/types.ts` |
| Format | bodymovin `.json`. **Not** `.lottie` — that needs a Metro `assetExts` change and a dotLottie runtime |
| Canvas | 1000 × 1000, square |
| Background | transparent — the app is `#000`, dark-only, and these play over the gradient backdrop |
| Loop | 2–4s, seamless |
| Accent | `rgb(231, 138, 83)` (primary-400, `TUTORIAL_ACCENT`) — the ONLY chromatic colour. Everything secondary is white at a reduced opacity, never a second hue |
| Size | ≤ 150 KB each. The largest here is 29 KB |
| Contents | vector only — no embedded rasters, no expressions |
| Subject | inside the middle 70%, i.e. 150..850 on both axes |

A scene block is `SCENE_HEIGHT` (200pt) tall and `contentFit`-style contained,
so anything near the canvas edges is letterboxed. That is what the middle-70%
line is for, and it is the line a piece most often fails.

## Validating one

`spike-artefacts/animation-tooling/` carries the generator and the validator
this set was built with. The validator decides every contract line a machine
can decide, including the two that a screenshot cannot:

- **the middle-70% sweep** walks every shape through every frame's transform
  and reports the real bounding box, rather than trusting the numbers in the
  source. The tooling spike failed exactly this and had to shrink its phone
  body from 680×740 to 386×680;
- **seam closure** per animated property. Each one must end on the value it
  started on, or be a rotation whose delta is a multiple of 360, or belong to a
  layer that is fully transparent at both frame 0 and frame N. A seam is the
  likeliest defect in a hand-built loop and a still frame cannot show it.

What is left for a device capture is the one question no script answers: does
the piece read as its idea at 200pt.

## Wiring one up

The seam is already in place and nothing about it needs inventing.

1. Drop `<id>.json` into this directory.
2. Uncomment that id's line in the matching registry —
   `components/custom/tutorials/animation-registry.ts` or
   `components/custom/processing/animation-registry.ts`. **An entry may exist
   there only once its file is on disk**: Metro resolves `require()` at bundle
   time, so an entry pointing at a missing file is a build error no runtime
   guard can catch. That trap is the entire reason each registry is one file.

Nothing else changes, at any N from 0 to 18. A tutorial slide with no entry
keeps its `ScenePlaceholder`; a processing stage with no entry keeps its
Reanimated/SVG fallback. The two coexist indefinitely.

Tutorial ids are derived, not declared: `SlideView` computes
`animationIdFor(chapterId, slide.id)` and hands it to `SceneView`, so
`lib/tutorials/chapters.ts` carries no `animation` field and does not need one.

## What is here

One hero per tutorial chapter — the chapter's opening slide. The other ~53
slides read correctly on their placeholders and can be backfilled in any order,
or never.

| # | Chapter | Hero id | Reads as |
|---|---|---|---|
| 1 | welcome | `welcome-what` | rings going out from one point, stories at the rim lighting as each reaches them |
| 2 | facts | `facts-a-fact-is` | several faint lines, one of which is true and completes |
| 3 | feed | `feed-two-lists` | one column and one grid, the same story lighting in both |
| 4 | teaching | `teaching-two-thumbs` | two controls tapped in turn, each sending out a ring |
| 5 | privacy | `privacy-stays-on-phone` | a phone holding things that stay inside it, one turning back at the boundary |
| 6 | following | `following-what-it-is` | a timeline whose right end is deliberately open |
| 7 | explore | `explore-unscored-on-purpose` | a grid that refuses to react to the sweep crossing it |
| 8 | sources | `sources-where-it-lives` | two doors, opened in turn |
| 9 | filters | `filters-three-shelves` | three shelves, things being put away on them |
| 10 | signal | `signal-the-dial` | a floor that rises and falls; marks below it stop being drawn |
| 11 | chat | `chat-where-mera-is` | a speech bubble, thinking |
| 12 | protocol | `protocol-one-screen` | three switches thrown and thrown back |

| Processing stage | Reads as |
|---|---|
| `processing-fetching` | signals arriving from the rim toward one centre |
| `processing-downloading` | articles landing on a shelf that is already partly full |
| `processing-grouping` | many marks drifting inward and becoming fewer |
| `processing-analysing` | a reading sweep crossing a still field, each mark lighting as it passes |
| `processing-summarising` | four lines writing themselves inside a note |
| `processing-preparing` | cards squaring up into a deck |

⚠️ Chapter `welcome` is the pre-auth chapter and **must never show the mera
logo** (explicit user instruction, asserted in `chapters.test.ts`). The mera
mark is a spotlight cone over a circle, so nothing cone-shaped appears in
`welcome-what`.
