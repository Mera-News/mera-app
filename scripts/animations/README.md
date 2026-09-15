# Animation tooling

The generator and the gate for `assets/animations/`. Python 3, no dependencies,
nothing to install.

```bash
cd mera-app
python3 scripts/animations/gen.py /tmp/anim-out     # write all eighteen
python3 scripts/animations/validate.py /tmp/anim-out
cp /tmp/anim-out/*.json assets/animations/          # only once validate exits 0
```

`validate.py` also takes the live directory (`python3 scripts/animations/validate.py
assets/animations`) and individual files, and exits non-zero on the first
problem, so it is usable as a gate rather than as a report.

## The three files

| | |
|---|---|
| `lib_bodymovin.py` | the schema primitives: `comp`, `keys`, `dot`, `ring`, `bar`, `outline`, `bell`. Nothing here decides how a piece looks |
| `gen.py` | the eighteen pieces, one function each. This is where the drawing lives |
| `validate.py` | every contract line a machine can decide |

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
  Everything secondary is white at a reduced opacity, never a second hue. Add a
  third colour and `validate.py` fails the file rather than quietly letting the
  set drift.
- **No keyframe wraps the loop boundary.** Every animated property either ends
  on the value it started on, or is a rotation whose delta is a multiple of 360,
  or belongs to a layer that is fully transparent at both frame 0 and frame N.
  That is what makes a loop seamless by construction instead of by inspection.

## What the validator catches that a screenshot cannot

- **The middle-70% sweep.** It walks every shape through every frame's group and
  layer transform and reports the real bounding box, rather than trusting the
  numbers in the source. A scene block is 200pt and contained, so anything
  outside 150..850 is letterboxed away. This found four defects in the first
  run of the eighteen, including a card entering at x 1065.
- **Seam closure**, per animated property. A seam is the likeliest defect in a
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
