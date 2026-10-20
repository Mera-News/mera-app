"""
Shared bodymovin primitives for the mera-news animation set.

Hand-authored against the bodymovin schema. No Lottie library is used and none
is installed in mera-app; this module only serialises structures.

Descends from spike-artefacts/animation-tooling/gen/handauthored.py, which
produced the three pieces that passed on device. Everything here is either that
file's vocabulary or a strict extension of it.

── The two rules every piece obeys ──────────────────────────────────────────

1. PALETTE. Exactly one chromatic fill, the accent rgb(231, 138, 83). Every
   secondary stroke is white at reduced OPACITY, never a second hue. That keeps
   `validate.py`'s "only chromatic fill" check strict rather than an allowlist.

2. SEAM. No keyframe wraps the loop boundary. Every animated property either
   ends on the value it started on, or belongs to a layer whose opacity is 0 at
   BOTH frame 0 and frame N, so the difference is never on screen. Rotation is
   the one exception and it is exact: a delta that is a multiple of 360 is the
   identical picture. `validate.py` asserts all three forms.
"""

import math
import re

ACCENT = [231 / 255, 138 / 255, 83 / 255, 1]
WHITE = [1, 1, 1, 1]


def comp(name, frames, layers, fr=30, w=1000, h=1000):
    """A composition. The canvas is per family (`validate.py` holds the table),
    so it is a parameter here and no primitive assumes a centre or a safe box."""
    return {
        "v": "5.7.4", "fr": fr, "ip": 0, "op": frames,
        "w": w, "h": h, "nm": name, "ddd": 0,
        "assets": [], "layers": layers, "markers": [],
    }


def stat(v):
    """A non-animated property."""
    return {"a": 0, "k": v}


def keys(frames_values, dim=1, hold=False, ease=None):
    """Animated property. `frames_values` is [(frame, value_list), ...].

    Eased in and out by default: the app's motion is calm and precise, never a
    bounce. `hold=True` gives step interpolation, for a value that must change
    without travelling through the values between; a third tuple element
    `"hold"` does the same for that one segment only. `ease` is a CSS
    cubic-bezier (x1, y1, x2, y2), e.g. (0, 0, 1, 1) for linear.
    """
    out = []
    if ease is None:
        ease_in = {"x": [0.6] * dim, "y": [1.0] * dim}
        ease_out = {"x": [0.4] * dim, "y": [0.0] * dim}
    else:
        x1, y1, x2, y2 = ease
        ease_in = {"x": [x2] * dim, "y": [y2] * dim}
        ease_out = {"x": [x1] * dim, "y": [y1] * dim}
    for i, entry in enumerate(frames_values):
        t, v = entry[0], entry[1]
        kf = {"t": t, "s": list(v)}
        if i < len(frames_values) - 1:
            if hold or (len(entry) > 2 and entry[2] == "hold"):
                kf["h"] = 1
            else:
                kf["i"] = ease_in
                kf["o"] = ease_out
        out.append(kf)
    return {"a": 1, "k": out}


def _ks(pos, opacity, rot=None, anchor=None, scale=None):
    return {
        "o": opacity,
        "r": rot if rot is not None else stat(0),
        "p": pos,
        "a": stat(anchor if anchor is not None else [0, 0, 0]),
        "s": scale if scale is not None else stat([100, 100, 100]),
    }


def _layer(ind, name, ks, items, op, ip=0, group=None):
    """One shape layer holding ONE group. `group` names the group; a themed
    (chat) layer is named by its colour role, so what the shape IS goes here."""
    return {
        "ddd": 0, "ind": ind, "ty": 4, "nm": name, "sr": 1, "ks": ks, "ao": 0,
        "shapes": [{"ty": "gr", "nm": group or name + "-g", "hd": False, "it": items}],
        "ip": ip, "op": op, "st": 0, "bm": 0,
    }


# Public names for generators that compose their own layers.
ks = _ks
layer = _layer


def tr(p=None, a=None, s=None, r=None, o=None):
    """A shape-group transform. The last item of every `it` list."""
    return {
        "ty": "tr",
        "p": p if p is not None else stat([0, 0]),
        "a": a if a is not None else stat([0, 0]),
        "s": s if s is not None else stat([100, 100]),
        "r": r if r is not None else stat(0),
        "o": o if o is not None else stat(100),
        "sk": stat(0), "sa": stat(0), "nm": "tr",
    }


def trim(start, end, offset=None):
    """Trim path. `start`/`end` are 0-100 (static or `keys`); draws a stroke on."""
    return {"ty": "tm", "nm": "tm", "s": start if isinstance(start, dict) else stat(start),
            "e": end if isinstance(end, dict) else stat(end),
            "o": offset if offset is not None else stat(0), "m": 1, "hd": False}


def fill(colour, opacity=100):
    return {"ty": "fl", "nm": "fl", "c": stat(colour), "o": stat(opacity),
            "r": 1, "hd": False}


def stroke(colour, width, opacity=100, dash=None):
    """`dash` is (dash, gap, offset) with offset static or `keys`."""
    out = {"ty": "st", "nm": "st", "c": stat(colour), "o": stat(opacity),
           "w": stat(width), "lc": 2, "lj": 1, "ml": 4, "hd": False}
    if dash is not None:
        d, g, o = dash
        out["d"] = [{"n": "d", "nm": "dash", "v": stat(d)},
                    {"n": "g", "nm": "gap", "v": stat(g)},
                    {"n": "o", "nm": "offset", "v": o if isinstance(o, dict) else stat(o)}]
    return out


def ellipse(diameter, p=(0, 0)):
    return {"ty": "el", "nm": "el", "d": 1, "p": stat(list(p)),
            "s": stat([diameter, diameter])}


def rect(w, h, radius, p=(0, 0)):
    return {"ty": "rc", "nm": "rc", "d": 1, "p": stat(list(p)),
            "s": stat([w, h]), "r": stat(radius)}


# ── layer builders ──────────────────────────────────────────────────────────

def dot(ind, name, diameter, colour, pos, opacity, rot=None, anchor=None,
        op=90, ip=0, offset=(0, 0), fill_op=100, scale=None):
    """One filled circle. `offset` draws it away from the layer's own anchor,
    which is what turns a layer ROTATION into a perfect orbit."""
    return _layer(ind, name, _ks(pos, opacity, rot, anchor, scale),
                  [ellipse(diameter, offset), fill(colour, fill_op), tr()],
                  op, ip)


def ring(ind, name, diameter, stroke_colour, stroke_w, pos, opacity,
         stroke_op=100, fill_colour=None, fill_op=0, op=90, ip=0, scale=None):
    it = [ellipse(diameter)]
    if fill_colour is not None:
        it.append(fill(fill_colour, fill_op))
    it.append(stroke(stroke_colour, stroke_w, stroke_op))
    it.append(tr())
    return _layer(ind, name, _ks(pos, opacity, None, None, scale), it, op, ip)


def bar(ind, name, w, h, radius, colour, pos, opacity, op=90, ip=0,
        fill_op=100, scale=None, anchor=None, rot=None, offset=(0, 0)):
    """A filled rounded rect. With `anchor` at one end and an animated x scale
    it draws itself from that end, which is how every 'writing' beat is built."""
    return _layer(ind, name, _ks(pos, opacity, rot, anchor, scale),
                  [rect(w, h, radius, offset), fill(colour, fill_op), tr()],
                  op, ip)


def outline(ind, name, w, h, radius, stroke_colour, stroke_w, pos, opacity,
            stroke_op=100, fill_colour=None, fill_op=0, op=90, ip=0,
            scale=None, anchor=None, offset=(0, 0)):
    it = [rect(w, h, radius, offset)]
    if fill_colour is not None:
        it.append(fill(fill_colour, fill_op))
    it.append(stroke(stroke_colour, stroke_w, stroke_op))
    it.append(tr())
    return _layer(ind, name, _ks(pos, opacity, None, anchor, scale), it, op, ip)


def bell(start, peak_in, peak_out, end, high=90):
    """The opacity shape every travelling mark uses: 0 at both ends of its own
    window, so it is invisible at the loop boundary whatever else it is doing."""
    return keys([(start, [0]), (peak_in, [high]), (peak_out, [high]), (end, [0])])


def matte(ind, items, ks_, op, ip=0):
    """A track-matte SOURCE: never drawn, it cuts the layer placed directly
    AFTER it in the layer list wherever `items` cover. Give that next layer
    `tt: 2` (alpha inverted) with `matted()`. This is how a travelling mark
    hides a line under it without a painted knockout in a panel colour."""
    out = _layer(ind, "matte", ks_, items, op, ip, group="matte")
    out["td"] = 1
    return out


def matted(layer_):
    """Mark `layer_` as cut by the matte layer right before it."""
    layer_["tt"] = 2
    return layer_


# ── SVG path data -> bodymovin `sh` ──────────────────────────────────────────

def _arc_to_cubics(x1, y1, rx, ry, phi, fa, fs, x2, y2):
    """SVG endpoint arc as cubic segments of at most 90 degrees each.
    Returns [(c1, c2, end), ...]."""
    if (x1, y1) == (x2, y2):
        return []
    if rx == 0 or ry == 0:
        return [((x1, y1), (x2, y2), (x2, y2))]
    rx, ry = abs(rx), abs(ry)
    cp, sp = math.cos(math.radians(phi)), math.sin(math.radians(phi))
    dx, dy = (x1 - x2) / 2.0, (y1 - y2) / 2.0
    x1p, y1p = cp * dx + sp * dy, -sp * dx + cp * dy
    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0.0, num / den)) * (-1 if fa == fs else 1)
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx
    cx = cp * cxp - sp * cyp + (x1 + x2) / 2.0
    cy = sp * cxp + cp * cyp + (y1 + y2) / 2.0

    def ang(ux, uy, vx, vy):
        a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return a

    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not fs and dt > 0:
        dt -= 2 * math.pi
    elif fs and dt < 0:
        dt += 2 * math.pi
    n = max(1, int(math.ceil(abs(dt) / (math.pi / 2) - 1e-9)))
    step = dt / n
    k = 4.0 / 3.0 * math.tan(step / 4)

    def pt(t):
        x, y = rx * math.cos(t), ry * math.sin(t)
        return (cp * x - sp * y + cx, sp * x + cp * y + cy)

    def dpt(t):
        x, y = -rx * math.sin(t), ry * math.cos(t)
        return (cp * x - sp * y, sp * x + cp * y)

    out = []
    for j in range(n):
        a, b = t1 + j * step, t1 + (j + 1) * step
        p0, p3 = pt(a), pt(b)
        d0, d3 = dpt(a), dpt(b)
        c1 = (p0[0] + k * d0[0], p0[1] + k * d0[1])
        c2 = (p3[0] - k * d3[0], p3[1] - k * d3[1])
        out.append((c1, c2, p3))
    out[-1] = (out[-1][0], out[-1][1], (x2, y2))
    return out


def _svg_subpaths(d):
    """Parse SVG path data (M L H V C S A Z, absolute and relative) into
    subpaths of absolute nodes [v, in_ctrl, out_ctrl] plus a closed flag."""
    toks = re.findall(r"[MmLlHhVvCcSsAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?", d)
    subs, nodes = [], None
    cur = start = (0.0, 0.0)
    last_c2 = None
    i, cmd = 0, None

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    def node(p):
        return [p, p, p]

    def line_to(p):
        nonlocal cur
        nodes.append(node(p))
        cur = p

    def curve_to(c1, c2, p):
        nonlocal cur
        nodes[-1][2] = c1
        n_ = node(p)
        n_[1] = c2
        nodes.append(n_)
        cur = p

    while i < len(toks):
        if re.match(r"[A-Za-z]", toks[i]):
            cmd = toks[i]
            i += 1
            if cmd in "Zz":
                if nodes:
                    if len(nodes) > 1 and math.dist(nodes[0][0], nodes[-1][0]) < 1e-6:
                        nodes[0][1] = nodes[-1][1]
                        nodes.pop()
                    subs.append((nodes, True))
                nodes, cur, last_c2 = None, start, None
                continue
        rel = cmd.islower()
        ox, oy = cur if rel else (0.0, 0.0)
        c = cmd.upper()
        if c == "M":
            if nodes:
                subs.append((nodes, False))
            p = (ox + num(), oy + num())
            nodes, cur, start = [node(p)], p, p
            cmd = "l" if rel else "L"
            last_c2 = None
            continue
        if nodes is None:
            nodes = [node(cur)]
        if c == "L":
            line_to((ox + num(), oy + num()))
            last_c2 = None
        elif c == "H":
            line_to(((ox if rel else 0.0) + num(), cur[1]))
            last_c2 = None
        elif c == "V":
            line_to((cur[0], (oy if rel else 0.0) + num()))
            last_c2 = None
        elif c == "C":
            c1 = (ox + num(), oy + num())
            c2 = (ox + num(), oy + num())
            p = (ox + num(), oy + num())
            curve_to(c1, c2, p)
            last_c2 = c2
        elif c == "S":
            c1 = (2 * cur[0] - last_c2[0], 2 * cur[1] - last_c2[1]) if last_c2 else cur
            c2 = (ox + num(), oy + num())
            p = (ox + num(), oy + num())
            curve_to(c1, c2, p)
            last_c2 = c2
        elif c == "A":
            rx, ry, phi, fa, fs = num(), num(), num(), num(), num()
            p = (ox + num(), oy + num())
            for c1, c2, q in _arc_to_cubics(cur[0], cur[1], rx, ry, phi, int(fa), int(fs), p[0], p[1]):
                curve_to(c1, c2, q)
            last_c2 = None
        else:
            raise ValueError(f"unsupported path command {cmd!r}")
    if nodes:
        subs.append((nodes, False))
    return subs


def path(d, scale=1.0):
    """SVG path data as `sh` items, one per subpath, scaled by `scale` (a chat
    piece is drawn at 5x its point size). Tangents are stored RELATIVE to their
    vertex, as bodymovin requires."""
    out = []
    for nodes, closed in _svg_subpaths(d):
        v = [[n[0][0] * scale, n[0][1] * scale] for n in nodes]
        ii = [[(n[1][0] - n[0][0]) * scale, (n[1][1] - n[0][1]) * scale] for n in nodes]
        oo = [[(n[2][0] - n[0][0]) * scale, (n[2][1] - n[0][1]) * scale] for n in nodes]
        out.append({"ty": "sh", "nm": "sh", "hd": False,
                    "ks": stat({"i": ii, "o": oo, "v": v, "c": closed})})
    return out

