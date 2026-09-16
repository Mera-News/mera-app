"""
Mechanical gate for every bodymovin file in mera-app/assets/animations/.

Eighteen pieces cannot each have a device round trip, so everything in the
asset contract that a machine can decide is decided here and the capture is
left to answer the one question a script cannot: does the piece read as its
idea at 200pt.

Checks, in contract order:

  1  canvas 1000 x 1000
  2  transparent: no full-canvas background shape
  3  seamless loop, 2.0 to 4.0 s  (duration from op/fr; seam proved per property)
     - or, for a DECLARED one-shot, 0.3 to 2.0 s with no seam requirement
  4  accent rgb(231,138,83) is the ONLY chromatic colour; everything else is
     greyscale, i.e. white at a reduced opacity
  5  <= 150 KB
  6  vector only: no image layers, empty `assets`, no expression fields
  7  subject inside the middle 70%: a frame-by-frame bbox sweep, not a guess
  8  frame 0 is the composition AT REST, in both modes
     8a nothing may be dark at frame 0, ever
     8b no named family of two or more layers may be entirely dark at frame 0
        while reaching real brightness elsewhere, unless it is declared in
        FRAME0_REST_EXCEPTIONS with a reason

Check 7 is the one that earns its keep. The spike FAILED it and had to correct
it: the phone body first spanned 74% of canvas height and was shrunk from
680x740 to 386x680. A capture finds that late; this finds it free.

Usage:  python3 validate.py <dir-or-file> [...]
Exit 0 iff every file passes every check.
"""
# ── one-shot mode ───────────────────────────────────────────────────────────
#
# A one-shot plays once and stops, so two of the seven checks above do not
# describe it: it has nothing to return to (seam), and holding it to a loop's
# 2.0 s floor would forbid the short reward flourishes the contract wants.
#
# One-shot mode relaxes EXACTLY those two, and nothing else. Duration is
# RE-BOUNDED to 0.3-2.0 s rather than removed, and seam closure is skipped.
# Canvas, transparency, palette, size ceiling, vector-only and the middle-70%
# sweep are unchanged in either mode. That is not a claim, it is proved by
# `python3 scripts/animations/test_one_shot_mode.py`, which breaks a real
# one-shot on each of those five dimensions in turn and asserts it still fails.
#
# This is an ALLOWLIST, not a flag, because the real gate
# (`validate.py assets/animations`) takes one directory argument over a mixed
# set of loop and one-shot files. A one-shot id NOT in this set is validated as
# a loop by default and fails loud on duration - forgetting to register a new
# one-shot cannot silently pass under the relaxed rules.
#
# Mirrored by ONE_SHOT_IDS in
# components/custom/processing/__tests__/animation-assets.test.ts, which derives
# its game half from GAME_REWARD_IDS. The two lists must move together; this is
# the copy `tsc` cannot reach.
#
# It lists only ids whose FILE IS ON DISK here. An entry for an absent asset
# would pre-authorise the relaxed band for a piece nobody has reviewed, which is
# the same mistake as a registry entry without a file, one layer down.
ONE_SHOT_IDS = {
    "game-mark-earn",
}
ONE_SHOT_LO, ONE_SHOT_HI = 0.3, 2.0
import json
import math
import os
import sys

ACCENT = (231 / 255, 138 / 255, 83 / 255)
SAFE_LO, SAFE_HI = 150.0, 850.0
MAX_BYTES = 150 * 1024
EPS = 1e-3

# Below this, a mark on a black ground is not the subject. Check 7 is asking
# where the COMPOSITION sits, and the first frame of a fade-in is not part of
# it: every travelling mark in this set starts its bell at 0 outside the box it
# arrives into, and counting that first barely-lit frame would fail every piece
# for something no reader can see.
VISIBLE_OPACITY = 8.0

# ── check 8: frame 0 is the composition at rest ─────────────────────────────
#
# `staticGradient` defaults ON below 6 GB of RAM, which covers both floor
# devices and an ordinary 4 GB iPhone, so a HELD FRAME 0 is the normal
# rendering for a large share of the fleet rather than a rare accessibility
# path. Frame 0 is therefore not the start of the animation, it is the
# animation, for those readers. A reduced or still presentation may remove
# MOTION; it may never remove MEANING-BEARING GEOMETRY.
#
# 8a has no allowlist and never will: a composition that is dark at frame 0
# renders as an empty box, and there is no piece for which that is right.
#
# 8b is the narrower one. A family authored as a travelling beat - every member
# on a `bell()`, 0 at both ends of its own window - is entirely dark at frame 0
# while carrying the whole subject mid-composition, which is what
# `processing-summarising`'s four `line-*` layers did: the static reader got a
# lone note glyph with none of its lines, every time.
#
# The legitimate case is a TRANSIENT HIGHLIGHT drawn over a base that is itself
# visible at rest. That earns an entry here with a stated reason, never a
# loosened threshold: the reason is the thing a reviewer reads, and a heuristic
# wide enough to admit a real highlight is wide enough to admit the defect.
#
# Keyed on (asset id, family) rather than family alone, so `head-*` being fine
# in one piece never pre-authorises a `head-*` somewhere nobody looked. An
# entry that no longer suppresses anything is reported as a problem for the
# same reason an allowlist entry for an absent file is: it pre-authorises a
# dark family for the next edit.
FRAME0_REST_EXCEPTIONS = {
    # Each reason names the layer family that STANDS IN for this one at rest.
    # That is the reviewable part: an entry whose named base does not exist, or
    # does not sit where this family sits, is a bad entry and readable as one.
    ("feed-two-lists", "row-lit"): (
        "the travelling highlight down the left column. `row-*` draws all five "
        "rows at 20% at the same coordinates, so the still frame is the column "
        "itself with nothing currently selected"
    ),
    ("feed-two-lists", "block-lit"): (
        "the counterpart highlight on the right. `block-*` draws all four "
        "section blocks at 20% at the same coordinates, so the two lists both "
        "read at rest and only the selection is missing"
    ),
    ("filters-three-shelves", "arriving"): (
        "marks travelling down onto a shelf. `shelf-*` and the six `kept-*` "
        "squares hold the shelves and what is already on them, so the still "
        "frame is three shelves with things put away, which is the slide"
    ),
    ("following-what-it-is", "pulse"): (
        "the ring that expands out of a node as the read-head passes it. "
        "`node-*` draws the node itself at 80% at the same coordinates, and "
        "`rail-`/`tick-`/`card-*` hold the whole timeline"
    ),
    ("processing-analysing", "lit"): (
        "the reading sweep's per-tile flash. `rest-{r}{c}` draws all sixteen "
        "tiles at 16% at exactly these coordinates, so the still frame is the "
        "field of articles with attention simply not moving over it"
    ),
    ("processing-downloading", "falling"): (
        "cards in flight toward the shelf. `shelf-*` plus the two accent "
        "`resident-*` rows draw a shelf that is already partly full, which the "
        "generator's own note calls the point of the piece"
    ),
    ("processing-fetching", "signal"): (
        "marks travelling in from the rim. `hub` and `hub-core` hold the "
        "centre they arrive at, and the piece's own note says the boundary is "
        "deliberately empty, so a rim crowded at rest would be the wrong still"
    ),
    ("processing-grouping", "mark"): (
        "duplicates travelling toward a cluster. `core-*` draws all three "
        "cluster rings at full opacity, so the still frame is the groups "
        "themselves, which is what the stage is named for"
    ),
    ("processing-preparing", "card"): (
        "cards arriving into the deck. `slot-*` draws all four slot outlines "
        "at 18% at exactly these coordinates, so the still frame is the deck "
        "arrangement with nothing currently in flight"
    ),
    ("processing-summarising", "head"): (
        "the writing head is a travelling cursor, not geometry. It carries no "
        "part of the note: it runs along `line-*`, which rests visible and dim "
        "at frame 0, so the still frame is the whole composition with the "
        "cursor simply not yet moving"
    ),
    ("sources-where-it-lives", "behind"): (
        "the light behind a door, and it MUST be dark at rest: `door-*` draws "
        "both doors closed at full opacity, and a closed door with its inside "
        "already showing is the wrong picture, not a missing one"
    ),
    ("teaching-two-thumbs", "ripple"): (
        "the ring a tap sends out. `pad-*` and `mark-*` draw both controls at "
        "full opacity at the same coordinates, so the still frame is the two "
        "controls, and the slide is about tapping them rather than about a ring"
    ),
    ("welcome-what", "reach"): (
        "rings travelling outward from the centre. `you` holds the centre at "
        "full opacity and the six `story-*` bars rest at 24%, so the still "
        "frame is you and the stories, with only the reach between them paused"
    ),
}

# A family whose peak never reaches this is dim everywhere, so being dark at
# frame 0 is not a change the reader can notice.
FAMILY_PEAK_FLOOR = 20.0


# ── property evaluation ─────────────────────────────────────────────────────

def _as_list(v):
    return list(v) if isinstance(v, (list, tuple)) else [v]


def eval_prop(prop, frame):
    """Value of a bodymovin property at `frame`, as a list.

    Linear between keyframes. The easing in these files is a cubic bezier whose
    control points all sit inside [0,1], so it never overshoots its endpoints
    and a linear read gives the same BOUNDS, which is all check 7 needs.
    """
    if prop is None:
        return [0]
    if prop.get("a", 0) == 0:
        return _as_list(prop["k"])
    kfs = prop["k"]
    if frame <= kfs[0]["t"]:
        return _as_list(kfs[0]["s"])
    for i in range(len(kfs) - 1):
        a, b = kfs[i], kfs[i + 1]
        if a["t"] <= frame <= b["t"]:
            if a.get("h") == 1 or b["t"] == a["t"]:
                return _as_list(a["s"])
            u = (frame - a["t"]) / (b["t"] - a["t"])
            av, bv = _as_list(a["s"]), _as_list(b["s"])
            n = min(len(av), len(bv))
            return [av[j] + (bv[j] - av[j]) * u for j in range(n)]
    return _as_list(kfs[-1]["s"])


def prop_frames(prop):
    if prop is None or prop.get("a", 0) == 0:
        return []
    return [kf["t"] for kf in prop["k"]]


# ── check 7: bbox sweep ─────────────────────────────────────────────────────

def _shape_extents(it):
    """Local corner points for every drawable in a group.

    A rect is given its four real corners, not a circumscribed radius: the
    circle around a 386x680 phone body is 391 wide against the body's own 193,
    and reporting that as the subject's extent fails a piece that is well
    inside the safe box. A circle is squared off, which is exact for it.
    """
    out = []
    for item in it:
        ty = item.get("ty")
        if ty not in ("el", "rc"):
            continue
        p = eval_prop(item["p"], 0)
        s = eval_prop(item["s"], 0)
        hw = s[0] / 2.0
        hh = (s[1] if len(s) > 1 else s[0]) / 2.0
        out.append([
            (p[0] - hw, p[1] - hh), (p[0] + hw, p[1] - hh),
            (p[0] + hw, p[1] + hh), (p[0] - hw, p[1] + hh),
        ])
    return out


def layer_bbox_sweep(layer, total_frames):
    """Worst-case world bbox of a layer over its whole visible life.

    A layer that is fully transparent at a frame contributes nothing at that
    frame: an invisible mark outside the safe box is not a composition problem.
    """
    ks = layer.get("ks", {})
    groups = [sh for sh in layer.get("shapes", []) if sh.get("ty") == "gr"]
    if not groups:
        return None
    lo_x = lo_y = float("inf")
    hi_x = hi_y = float("-inf")
    saw = False
    for frame in range(0, total_frames + 1):
        if frame < layer.get("ip", 0) or frame > layer.get("op", total_frames):
            continue
        if eval_prop(ks.get("o"), frame)[0] < VISIBLE_OPACITY:
            continue
        pos = eval_prop(ks.get("p"), frame)
        anchor = eval_prop(ks.get("a"), frame)
        rot = math.radians(eval_prop(ks.get("r"), frame)[0])
        sc = eval_prop(ks.get("s"), frame)
        sx, sy = sc[0] / 100.0, (sc[1] if len(sc) > 1 else sc[0]) / 100.0
        for group in groups:
            it = group.get("it", [])
            gtr = next((i for i in it if i.get("ty") == "tr"), None)
            gp = eval_prop(gtr["p"], frame) if gtr else [0, 0]
            ga = eval_prop(gtr["a"], frame) if gtr else [0, 0]
            gs = eval_prop(gtr["s"], frame) if gtr else [100, 100]
            gsx, gsy = gs[0] / 100.0, (gs[1] if len(gs) > 1 else gs[0]) / 100.0
            for corners in _shape_extents(it):
                for lp in corners:
                    # group transform, then layer transform
                    x = (lp[0] - ga[0]) * gsx + gp[0]
                    y = (lp[1] - ga[1]) * gsy + gp[1]
                    x = (x - anchor[0]) * sx
                    y = (y - anchor[1]) * sy
                    rx = x * math.cos(rot) - y * math.sin(rot) + pos[0]
                    ry = x * math.sin(rot) + y * math.cos(rot) + pos[1]
                    lo_x, hi_x = min(lo_x, rx), max(hi_x, rx)
                    lo_y, hi_y = min(lo_y, ry), max(hi_y, ry)
                    saw = True
    return (lo_x, lo_y, hi_x, hi_y) if saw else None


# ── check 3: seam closure ───────────────────────────────────────────────────

def seam_problems(layer, total_frames):
    """Every animated property must close its own loop.

    Three ways to be seamless, all three accepted:
      (1) the first and last keyframe hold the same value;
      (2) the property is a ROTATION whose delta is a multiple of 360, which is
          the identical picture and is how every orbit in this set is built;
      (3) the layer is fully transparent at BOTH frame 0 and frame N, so
          whatever the property does at the boundary is not on screen.
    """
    ks = layer.get("ks", {})
    o_start = eval_prop(ks.get("o"), 0)[0]
    o_end = eval_prop(ks.get("o"), total_frames)[0]
    invisible_at_both_ends = o_start <= 1.0 and o_end <= 1.0
    if invisible_at_both_ends:
        return []

    problems = []
    for name, prop in ks.items():
        if not isinstance(prop, dict) or prop.get("a", 0) != 1:
            continue
        first = _as_list(prop["k"][0]["s"])
        last = _as_list(prop["k"][-1]["s"])
        if all(abs(a - b) < EPS for a, b in zip(first, last)):
            continue
        if name == "r":
            delta = last[0] - first[0]
            if abs(delta % 360.0) < EPS or abs(delta % 360.0 - 360.0) < EPS:
                continue
        problems.append(
            f"layer '{layer.get('nm')}' property '{name}' does not close its "
            f"loop: {first} -> {last}"
        )
    return problems


# ── check 8: frame 0 at rest ────────────────────────────────────────────────

def layer_opacity_at(layer, frame, total):
    """Effective opacity of a layer at `frame`, on the 0-100 scale.

    Zero outside the layer's own `ip`..`op` window, since a layer that is not
    in yet draws nothing whatever its opacity property says. The shape group's
    own transform opacity multiplies the layer's, and a layer holding several
    groups is as lit as its brightest one.
    """
    if frame < layer.get("ip", 0) or frame > layer.get("op", total):
        return 0.0
    base = eval_prop(layer.get("ks", {}).get("o"), frame)[0]
    groups = [sh for sh in layer.get("shapes", []) if sh.get("ty") == "gr"]
    if not groups:
        return base
    best = 0.0
    for group in groups:
        gtr = next((i for i in group.get("it", []) if i.get("ty") == "tr"), None)
        g = eval_prop(gtr.get("o"), frame)[0] if gtr is not None else 100.0
        best = max(best, base * g / 100.0)
    return best


def family_of(name):
    """'line-3' -> 'line'. A trailing -<digits> is the index within a family.

    A name with no index is its own family, so two layers that share a name
    exactly are still read as one family rather than slipping through.
    """
    if not name:
        return ""
    head, sep, tail = name.rpartition("-")
    return head if sep and head and tail.isdigit() else name


def frame0_rest_problems(doc, asset_id, total):
    problems = []
    layers = doc.get("layers", [])
    if not layers:
        return problems

    # 8a - no allowlist, in either mode.
    if not any(layer_opacity_at(l, 0, total) >= VISIBLE_OPACITY for l in layers):
        problems.append(
            f"nothing is lit at frame 0: every layer is below the "
            f"{VISIBLE_OPACITY:.0f}% visible floor, so a reader holding frame 0 "
            f"sees an empty box rather than the composition at rest"
        )

    # 8b - per named family, with a reasoned allowlist.
    families = {}
    for layer in layers:
        families.setdefault(family_of(layer.get("nm")), []).append(layer)

    used = set()
    for fam, members in sorted(families.items()):
        if len(members) < 2:
            continue
        if any(layer_opacity_at(m, 0, total) >= VISIBLE_OPACITY for m in members):
            continue
        peak = max(
            layer_opacity_at(m, f, total)
            for m in members
            for f in range(total + 1)
        )
        if peak < FAMILY_PEAK_FLOOR:
            continue
        if (asset_id, fam) in FRAME0_REST_EXCEPTIONS:
            used.add(fam)
            continue
        problems.append(
            f"family '{fam}-*' ({len(members)} layers) is entirely dark at "
            f"frame 0 but reaches {peak:.0f}% elsewhere, so a held frame 0 "
            f"drops it from the composition. Give it a dim rest state, or "
            f"declare it in FRAME0_REST_EXCEPTIONS with a reason"
        )

    for (ex_asset, ex_fam), _reason in sorted(FRAME0_REST_EXCEPTIONS.items()):
        if ex_asset == asset_id and ex_fam not in used:
            problems.append(
                f"FRAME0_REST_EXCEPTIONS carries '{ex_fam}-*' for this file and "
                f"it no longer suppresses anything: delete the entry rather "
                f"than leaving a dark family pre-authorised"
            )
    return problems


# ── checks 2, 4, 6 ──────────────────────────────────────────────────────────

def walk_items(items):
    for item in items:
        yield item
        if isinstance(item, dict) and isinstance(item.get("it"), list):
            yield from walk_items(item["it"])


def colour_problems(layer):
    problems = []
    for group in layer.get("shapes", []):
        for item in walk_items([group]):
            if not isinstance(item, dict) or item.get("ty") not in ("fl", "st"):
                continue
            c = eval_prop(item.get("c"), 0)
            if len(c) < 3:
                problems.append(f"layer '{layer.get('nm')}': malformed colour {c}")
                continue
            r, g, b = c[0], c[1], c[2]
            is_accent = all(abs(x - y) < 0.01 for x, y in zip((r, g, b), ACCENT))
            is_grey = abs(r - g) < 0.01 and abs(g - b) < 0.01
            if not (is_accent or is_grey):
                problems.append(
                    f"layer '{layer.get('nm')}': colour {[round(v, 3) for v in (r, g, b)]} "
                    f"is neither the accent nor greyscale"
                )
    return problems


def background_problems(layer):
    problems = []
    for group in layer.get("shapes", []):
        for item in walk_items([group]):
            if not isinstance(item, dict) or item.get("ty") not in ("el", "rc"):
                continue
            s = eval_prop(item.get("s"), 0)
            if len(s) >= 2 and s[0] >= 900 and s[1] >= 900:
                problems.append(
                    f"layer '{layer.get('nm')}': shape {s} covers the canvas, "
                    f"which is a background the app is supposed to show through"
                )
    return problems


def expression_problems(layer):
    problems = []
    ks = layer.get("ks", {})
    for name, prop in ks.items():
        if isinstance(prop, dict) and "x" in prop:
            problems.append(f"layer '{layer.get('nm')}': property '{name}' carries an expression")
    return problems


# ── driver ──────────────────────────────────────────────────────────────────

def validate(path, one_shot=False):
    problems = []
    size = os.path.getsize(path)
    with open(path, "r", encoding="utf-8") as fh:
        try:
            doc = json.load(fh)
        except Exception as exc:                                  # noqa: BLE001
            return size, None, [f"not valid JSON: {exc}"]

    if doc.get("w") != 1000 or doc.get("h") != 1000:
        problems.append(f"canvas is {doc.get('w')}x{doc.get('h')}, contract says 1000x1000")

    fr = doc.get("fr") or 30
    total = doc.get("op", 0)
    duration = total / fr
    if one_shot:
        if not (ONE_SHOT_LO - EPS <= duration <= ONE_SHOT_HI + EPS):
            problems.append(
                f"one-shot duration {duration:.2f}s is outside the "
                f"{ONE_SHOT_LO} to {ONE_SHOT_HI} s one-shot contract"
            )
    elif not (2.0 - EPS <= duration <= 4.0 + EPS):
        problems.append(f"duration {duration:.2f}s is outside the 2 to 4 s contract")

    if size > MAX_BYTES:
        problems.append(f"{size} bytes is over the {MAX_BYTES} byte ceiling")

    if doc.get("assets"):
        problems.append("`assets` is not empty, so the file is not vector-only")

    for layer in doc.get("layers", []):
        if layer.get("ty") == 2:
            problems.append(f"layer '{layer.get('nm')}' is an IMAGE layer")
        problems += colour_problems(layer)
        problems += background_problems(layer)
        problems += expression_problems(layer)
        if not one_shot:
            problems += seam_problems(layer, total)

    # Check 8 runs in BOTH modes. A one-shot is held at frame 0 by exactly the
    # same readers, and playing once is not a reason to start from nothing.
    problems += frame0_rest_problems(
        doc, os.path.splitext(os.path.basename(path))[0], total
    )

    lo_x = lo_y = float("inf")
    hi_x = hi_y = float("-inf")
    for layer in doc.get("layers", []):
        box = layer_bbox_sweep(layer, total)
        if box is None:
            continue
        lo_x, lo_y = min(lo_x, box[0]), min(lo_y, box[1])
        hi_x, hi_y = max(hi_x, box[2]), max(hi_y, box[3])
    if lo_x == float("inf"):
        problems.append("nothing is ever drawn")
        bounds = None
    else:
        bounds = (lo_x, lo_y, hi_x, hi_y)
        if lo_x < SAFE_LO - EPS or lo_y < SAFE_LO - EPS or hi_x > SAFE_HI + EPS or hi_y > SAFE_HI + EPS:
            problems.append(
                f"subject leaves the middle 70%: x {lo_x:.0f}..{hi_x:.0f}, "
                f"y {lo_y:.0f}..{hi_y:.0f}, allowed {SAFE_LO:.0f}..{SAFE_HI:.0f}"
            )
    return size, (duration, bounds), problems


def main(argv):
    targets = []
    # `--one-shot` forces one-shot mode on every target named AFTER it, so a
    # fixture that is deliberately NOT in ONE_SHOT_IDS can still be exercised
    # under the relaxed rules. It is not how the real gate decides mode - see
    # ONE_SHOT_IDS's own comment.
    force_one_shot = False
    for arg in argv:
        if arg == "--one-shot":
            force_one_shot = True
            continue
        if os.path.isdir(arg):
            targets += sorted(
                (
                    os.path.join(arg, f),
                    force_one_shot or os.path.splitext(f)[0] in ONE_SHOT_IDS,
                )
                for f in os.listdir(arg)
                if f.endswith(".json")
            )
        else:
            base = os.path.splitext(os.path.basename(arg))[0]
            targets.append((arg, force_one_shot or base in ONE_SHOT_IDS))
    if not targets:
        print("no .json files given")
        return 1

    failed = 0
    print(f"{'file':<38} {'bytes':>7} {'secs':>5}  {'x range':>11} {'y range':>11}  result")
    for path, one_shot in targets:
        size, info, problems = validate(path, one_shot=one_shot)
        name = os.path.basename(path)
        if info and info[1]:
            dur, (lo_x, lo_y, hi_x, hi_y) = info
            span = f"{lo_x:>4.0f}..{hi_x:<4.0f}", f"{lo_y:>4.0f}..{hi_y:<4.0f}"
        else:
            dur, span = (info[0] if info else 0), ("-", "-")
        verdict = "OK" if not problems else f"{len(problems)} PROBLEM(S)"
        print(f"{name:<38} {size:>7} {dur:>5.2f}  {span[0]:>11} {span[1]:>11}  {verdict}")
        for p in problems:
            print(f"    - {p}")
        if problems:
            failed += 1
    print(f"\n{len(targets)} file(s), {failed} failing")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
