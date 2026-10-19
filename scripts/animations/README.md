# Animation tooling

The generator and the gate for `assets/animations/`. Python 3, no dependencies,
nothing to install.

```bash
cd mera-app
python3 scripts/animations/gen.py /tmp/anim-out       # the 1000 x 1000 family
python3 scripts/animations/gen_chat.py /tmp/anim-out  # the chat strips and glyphs
python3 scripts/animations/validate.py /tmp/anim-out
cp /tmp/anim-out/<the files you changed>.json assets/animations/   # only once validate exits 0
python3 scripts/animations/test_one_shot_mode.py      # after touching validate.py or the lib
python3 scripts/animations/test_chat_families.py
```

Regenerating with `gen.py` must leave its files byte-identical unless you meant
to change one: compare with `cmp` before copying anything.

`validate.py` also takes the live directory (`python3 scripts/animations/validate.py
assets/animations`) and individual files, and exits non-zero on the first
problem, so it is usable as a gate rather than as a report.

## The files

| | |
|---|---|
| `lib_bodymovin.py` | the schema primitives: `comp` (canvas per call), `keys` (per-segment hold, CSS-style easing), `dot`, `ring`, `bar`, `outline`, `bell`, `path` (SVG path data, arcs included, to `sh`), `trim`, dashed `stroke`, `matte`/`matted`. Nothing here decides how a piece looks |
| `gen.py` | the 1000 x 1000 pieces, one function each. It owns its own `CX`/`CY` |
| `gen_chat.py` | the chat strips and step glyphs, drawn in the design board's point units at 5x. Durations are named constants at the top |
| `validate.py` | every contract line a machine can decide, per canvas family |
| `test_one_shot_mode.py`, `test_chat_families.py` | proof the gate can fail: each breaks one rule and asserts the matching failure, beside a positive control |

No Lottie library is involved, on purpose. The tooling spike established that a
library is not needed to author bodymovin and that the one it tried
(`@lottiefiles/lottie-js`) cannot author from scratch at all: `createLayer('shape')`
throws, and `EllipseShape` emits a scalar where the schema requires `[x, y]`.
Knowing the schema is what makes this work; a tool is not.

## Changing a piece

Edit its function in `gen.py`, regenerate, validate, copy. The functions are
independent and share only the primitives, so a change to one cannot move
another.

Two rules the whole set obeys, and the validator enforces both:

- **One chromatic colour.** The accent `rgb(231, 138, 83)` is the subject.
  Everything secondary is greyscale, never a second hue. Add a third colour and
  `validate.py` fails the file rather than quietly letting the set drift. Chat
  pieces add the theming rules in `assets/animations/README.md`.
- **No keyframe wraps the loop boundary.** Every animated property either ends
  on the value it started on, or is a rotation whose delta is a multiple of 360,
  or belongs to a layer that is fully transparent at both frame 0 and frame N.
  That is what makes a loop seamless by construction instead of by inspection.

## What the validator catches that a screenshot cannot

- **The safe-box sweep.** It walks every shape through every frame's group and
  layer transform and reports the real bounding box, rather than trusting the
  numbers in the source. A 1000 x 1000 scene block is 200pt and contained, so
  anything outside 150..850 is letterboxed away. A chat piece renders at exact
  size, so its box is the canvas, measured with half the stroke width. Paths
  count their curve control points, so a round top is never under-measured. This found four defects in the first
  run of the eighteen, including a card entering at x 1065.
- **Seam closure**, per animated property, layer transforms and everything
  animated inside the shapes (group transforms, trims, dash offsets). A seam is the likeliest defect in a
  hand-built loop and a still frame cannot show it. Three of the eighteen had a
  fade window that ran past the last frame, which leaves a mark half lit at the
  boundary.

A rect is measured on its four real corners, not a circumscribed radius: the
circle around a 386x680 phone body is 391 wide against the body's own 193, and
using it failed a piece that sits well inside the box. A mark under 8% opacity
does not count toward the bounds, because the first frame of a fade-in is not
part of the composition and counting it would fail every piece for something no
reader can see.

## Where it came from

`plans/done/ANIMATION_TOOLING_SPIKE.md` compared Lottie, Rive and code-authored
Reanimated + SVG and recommended Lottie: it is the only candidate that both
ships over the air on the current binary and leaves a designer a file they can
open. The spike's own `handauthored.py` is the direct ancestor of
`lib_bodymovin.py`.
