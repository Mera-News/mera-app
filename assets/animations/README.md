# Animations

The app's bodymovin files, in four families: tutorial heroes and gesture
hints, feed processing stages, game pieces, and the chat secure-wait strips and
step glyphs. They are agent-authored, written straight against the bodymovin
schema, and every one of them is gated by a script before it lands (see
"Validating one", below).

**The runtime is in the binary.** `lottie-react-native ~7.3.4` was banked in
`baff527`, an ancestor of the 1.3.1 version bump, so the 1.3.1 and 1.3.4
binaries carry the native module and this whole directory ships over the air. Prove it the same way before trusting it again, because a binary cut
BEFORE the banking would crash on an OTA that references Lottie:

```
git log -S'lottie-react-native' --format=%h -- package.json | tail -1
git merge-base --is-ancestor <that hash> <the binary's commit> ; echo $?
```

Exit 0 or it is not in that binary. `runtimeVersion` is `{policy: 'appVersion'}`,
so every app version is its own runtime and an OTA is published once per live
runtime.

## The contract

| | |
|---|---|
| Filename, tutorials | `<chapter>-<slide>.json` — exactly `animationIdFor()` in `lib/algorithms/tutorial-keys.ts` |
| Filename, processing | `processing-<stageId>.json` — the six ids in `components/custom/processing/types.ts` |
| Filename, game | `game-<surface>-<moment>.json` — `components/custom/game-ui/animation-registry.ts` |
| Filename, chat | `chat-strip-<state>.json` and `chat-step-<kind>.json` — `components/custom/chat/animation-registry.ts`. Match these exact prefixes, never `chat-`: `chat-where-mera-is.json` is a tutorial hero |
| Format | bodymovin `.json`. **Not** `.lottie` — that needs a Metro `assetExts` change and a dotLottie runtime |
| Canvas | 1000 × 1000 square; `chat-strip-*` 1360 × 160 (the 272 × 32 strip at 5x); `chat-strip-device` 140 × 160 (28 × 32 at 5x); `chat-step-*` 100 × 100 (20 × 20 at 5x) |
| Background | transparent: no shape covering 90% of the canvas. The app shows its own surface through it, in the light and the dark theme |
| Loop | 2–4s, seamless |
| One-shot | 0.3–2.0s, no seam requirement — and only for an id DECLARED as one, see below |
| Accent | `rgb(231, 138, 83)` (primary-400, `TUTORIAL_ACCENT`) — the ONLY chromatic colour. Everything secondary is greyscale, never a second hue |
| Size | ≤ 150 KB each. The largest here is 29 KB |
| Contents | vector only — no embedded rasters, no expressions |
| Subject | 1000 family: inside the middle 70%, i.e. 150..850 on both axes. Chat families render at exact size, so the box is the whole canvas, measured on geometry plus half the stroke width |
| Occupancy | fill roughly half the canvas. Not machine-checked — see below |

A scene block is `SCENE_HEIGHT` (200pt) tall and `contentFit`-style contained,
so anything near the canvas edges is letterboxed. That is what the middle-70%
line is for, and it is the line a piece most often fails.

**Occupancy is the line the validator cannot hold for you.** The middle-70%
sweep only proves a subject is not too BIG; nothing proves it is not too small,
and a piece authored for a small host renders as a speck when it is dropped into
a large one. `game-hud-idle` was authored at 14% occupancy for a header band and
had to be rescaled to 54% for a 96pt card scene, where 14% had put its ring
stroke at 0.58 of a physical pixel — below the rendering floor, so the piece was
invisible while passing every check. The pieces here sit between 42% and 68%;
match that band, and compare against the pieces yours renders beside rather than
against the canvas.

## Chat pieces and the light theme

The chat strips and glyphs are recoloured at runtime, so they follow rules the
other families do not. `validate.py` and the asset gate enforce each one.

- **Every drawn layer is named exactly `ink`, `ink3` or `accent`.** The app
  passes lottie-react-native `colorFilters` keyed on those names (native code
  builds the keypath `<name>.**`), mapping `ink` to the theme's ink2, `ink3`
  to ink3 and `accent` to accentMark. What a layer draws is its group's name.
- **Filter colours must be opaque.** Android applies the filter as SRC_ATOP,
  so a translucent colour tints the shape instead of fading it. Flatten an
  alpha token against the surface behind the strip; dims live in the file as
  layer opacity. On iOS one malformed filter entry drops every entry after it.
- **No colour animates.** A filter replaces the whole colour property, so a
  highlight is an accent shape fading in over an ink3 one.
- **No painted knockouts.** A panel-coloured fill shows as a patch on the other
  theme's surface. A static overlap is a broken path; a moving one (the sealed
  letter over the line, a lens over the globe) is an alpha-inverted track matte
  (`td: 1` source directly above a `tt: 2` layer).
- **The model end of a cloud strip stays empty** (x 244..266 of 272), and so
  does the device phone screen apart from its loading fill: the app lays the
  real MeraLogo there (`CHAT_STRIP_MARK_BOX`, `CHAT_DEVICE_SCREEN_BOX`).
- **Resting frames.** Loops (`phone`, `think`, `device`, every glyph) rest on
  frame 0 = their last frame. The strip one-shots (`attest`, `secure`, `retry`,
  `return`) rest on their LAST frame, so motion off is progress 1 for them and
  0 for everything else. `chat-strip-device` plays only during model loading
  and holds frame 0 (the phone alone) otherwise.

## One-shots

A piece that plays once and stops has nothing to return to, so seam closure does
not describe it, and the 2s loop floor would forbid a short flourish. One-shot
mode relaxes **exactly those two** checks: duration is RE-BOUNDED to 0.3–2.0s
rather than removed, and seam closure is skipped. Canvas, transparency, palette,
size ceiling, vector-only and the middle-70% sweep all still apply.

It is an **allowlist, not a flag**. The real gate runs over one directory holding
both kinds, so a one-shot id must be declared in all three of:

- `ONE_SHOT_IDS` in `scripts/animations/validate.py`
- `GAME_REWARD_IDS` in `components/custom/game-ui/animation-registry.ts`, or
  `CHAT_ONE_SHOT_IDS` in `components/custom/chat/animation-registry.ts`
- (the asset gate derives its own list from those arrays, so it needs no third edit)

An id in none of them is validated as a loop and fails loud on duration. That is
the designed failure: forgetting to declare a one-shot cannot silently pass under
the relaxed band. `python3 scripts/animations/test_one_shot_mode.py` is the proof
that the relaxation is narrow — it breaks a real one-shot on each of the five
still-enforced dimensions in turn and asserts each one still fails.

## Validating one

`scripts/animations/` carries the generator and the validator this set was
built with, and its own README says how to run them. The validator decides
every contract line a machine can decide, including the two that a screenshot
cannot:

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
   `components/custom/tutorials/animation-registry.ts`,
   `components/custom/processing/animation-registry.ts`,
   `components/custom/game-ui/animation-registry.ts` or
   `components/custom/chat/animation-registry.ts`. One family, one registry:
   a second `require()` site for the same file is two homes for one thing.
   **An entry may exist
   there only once its file is on disk**: Metro resolves `require()` at bundle
   time, so an entry pointing at a missing file is a build error no runtime
   guard can catch. That trap is the entire reason each registry is one file.

Nothing else changes. A tutorial slide with no entry
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

| Chat piece | Plays | Reads as |
|---|---|---|
| `chat-strip-phone` | loop | the phone breathes; line and gateway ring dim; nothing crosses |
| `chat-strip-attest` | once | the line marches in dashes and the key travels to the phone |
| `chat-strip-secure` | once | the message bars break into cipher dots and the sealed letter travels to the model end |
| `chat-strip-think` | loop, still | the letter rests by the model end; the app's MeraLogo cone moves |
| `chat-strip-retry` | once | the letter fades and travels again |
| `chat-strip-return` | once, 0.5 s | the letter travels back to the phone (350 ms) and its lock opens |
| `chat-strip-device` | loop | the phone alone; its screen fills while the model loads |
| `chat-step-{think,skill,facts,place,write,remove,ask,web}` | loop | the step's own work: dots light, a page turns, a lens slides, a pin lifts, a line is written, a card slides out, a question mark bobs, a lens sweeps a globe |
