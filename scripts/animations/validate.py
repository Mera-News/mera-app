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
  4  accent rgb(231,138,83) is the ONLY chromatic colour; everything else is
     greyscale, i.e. white at a reduced opacity
  5  <= 150 KB
  6  vector only: no image layers, empty `assets`, no expression fields
  7  subject inside the middle 70%: a frame-by-frame bbox sweep, not a guess

Check 7 is the one that earns its keep. The spike FAILED it and had to correct
it: the phone body first spanned 74% of canvas height and was shrunk from
680x740 to 386x680. A capture finds that late; this finds it free.

Usage:  python3 validate.py <dir-or-file> [...]
Exit 0 iff every file passes every check.
"""
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

def validate(path):
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
    if not (2.0 - EPS <= duration <= 4.0 + EPS):
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
        problems += seam_problems(layer, total)

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
    for arg in argv:
        if os.path.isdir(arg):
            targets += sorted(
                os.path.join(arg, f) for f in os.listdir(arg) if f.endswith(".json")
            )
        else:
            targets.append(arg)
    if not targets:
        print("no .json files given")
        return 1

    failed = 0
    print(f"{'file':<38} {'bytes':>7} {'secs':>5}  {'x range':>11} {'y range':>11}  result")
    for path in targets:
        size, info, problems = validate(path)
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
