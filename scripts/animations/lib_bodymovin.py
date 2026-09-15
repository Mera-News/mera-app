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

ACCENT = [231 / 255, 138 / 255, 83 / 255, 1]
WHITE = [1, 1, 1, 1]
CX = CY = 500

# The contract's safe box: a scene block is 200pt and contained, so anything
# outside the middle 70% is letterboxed away.
SAFE_LO, SAFE_HI = 150, 850


def comp(name, frames, layers, fr=30):
    return {
        "v": "5.7.4", "fr": fr, "ip": 0, "op": frames,
        "w": 1000, "h": 1000, "nm": name, "ddd": 0,
        "assets": [], "layers": layers, "markers": [],
    }


def stat(v):
    """A non-animated property."""
    return {"a": 0, "k": v}


def keys(frames_values, dim=1, hold=False):
    """Animated property. `frames_values` is [(frame, value_list), ...].

    Eased in and out by default: the app's motion is calm and precise, never a
    bounce. `hold=True` gives step interpolation, for a value that must change
    without travelling through the values between.
    """
    out = []
    ease_in = {"x": [0.6] * dim, "y": [1.0] * dim}
    ease_out = {"x": [0.4] * dim, "y": [0.0] * dim}
    for i, (t, v) in enumerate(frames_values):
        kf = {"t": t, "s": list(v)}
        if i < len(frames_values) - 1:
            if hold:
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


def _layer(ind, name, ks, items, op, ip=0):
    return {
        "ddd": 0, "ind": ind, "ty": 4, "nm": name, "sr": 1, "ks": ks, "ao": 0,
        "shapes": [{"ty": "gr", "nm": name + "-g", "hd": False, "it": items}],
        "ip": ip, "op": op, "st": 0, "bm": 0,
    }


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


def fill(colour, opacity=100):
    return {"ty": "fl", "nm": "fl", "c": stat(colour), "o": stat(opacity),
            "r": 1, "hd": False}


def stroke(colour, width, opacity=100):
    return {"ty": "st", "nm": "st", "c": stat(colour), "o": stat(opacity),
            "w": stat(width), "lc": 2, "lj": 1, "ml": 4, "hd": False}


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
