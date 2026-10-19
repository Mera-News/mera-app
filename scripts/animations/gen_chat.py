"""
The chat animation pieces: seven secure-wait strips and eight step glyphs.

    python3 scripts/animations/gen_chat.py <out-dir>
    python3 scripts/animations/validate.py <out-dir>

A separate generator from `gen.py` so the 1000 x 1000 family can never move
when a chat piece changes. The source of every number below is the design
board (https://claude.ai/artifact/N7xR16mThJXikpBFKyJoHj, `wait-strip.css`,
`WaitBubble.dc.html`, `StepGlyph.dc.html`), translated, not ported: geometry
is written in the board's point units and drawn at 5x.

House rules for this family (validate.py enforces each):
  * Every drawn layer is named by its colour ROLE, `ink`, `ink3` or `accent`,
    because the app recolours them per theme with colorFilters keyed on the
    layer name. What a layer draws is its group's name. `ink` carries the
    board's ink2 lines: the app maps the `ink` keypath to ink2.
  * No colour ever animates. A highlight is an accent shape fading in over an
    ink3 one.
  * No painted knockouts. A shape that covers another while it MOVES does so
    with a track matte; a static overlap is drawn as a broken path.
  * Loops rest on frame 0 and end where they began. The four strip one-shots
    rest on their LAST frame.
  * The strip draws nothing at the model end (x 244..266): the app lays the
    real MeraLogo there.
"""
import json
import math
import os
import sys

from lib_bodymovin import (
    ACCENT, WHITE, comp, stat, keys, layer, ks, path, stroke, fill, rect,
    ellipse, tr, trim, matte, matted,
)

OUT = sys.argv[1] if len(sys.argv) > 1 else "out-chat"
os.makedirs(OUT, exist_ok=True)

S = 5            # drawn at 5x the point size
FR = 60          # so 350 ms is exactly 21 frames
GREY = [0.5, 0.5, 0.5, 1]   # base colour of `ink3`; the app replaces it
TRAVEL = (0.45, 0, 0.25, 1)  # the board's cubic-bezier for every journey
EASE_OUT = (0, 0, 0.58, 1)
LINEAR = (0, 0, 1, 1)

# Lengths in seconds. SECURE_S and RETRY_S are the board's 2.2 s and 2.4 s
# compressed into the 2.0 s one-shot band; retune them here from P0's numbers.
PHONE_S, ATTEST_S, SECURE_S, THINK_S, RETRY_S, RETURN_S, DEVICE_S = 3.2, 1.6, 2.0, 2.0, 2.0, 0.5, 2.0
RETURN_TRAVEL_F = 21   # 350 ms of letter travel, then the lock opens

WRITTEN = []


def f(seconds):
    return int(round(seconds * FR))


def u(x, y):
    """A board point at 5x, as a layer position."""
    return [x * S, y * S, 0]


def write(name, frames, layers, w, h):
    target = os.path.join(OUT, name + ".json")
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(comp(name, frames, layers, FR, w, h), fh, separators=(",", ":"))
    WRITTEN.append((name, os.path.getsize(target)))


class Ind:
    def __init__(self):
        self.n = 0

    def __call__(self):
        self.n += 1
        return self.n


def lay(ind, role, groups, op, p=None, o=None, r=None, a=None, s=None):
    """A role layer holding one or more named groups [(name, items), ...]."""
    out = layer(ind, role, ks(p or stat([0, 0, 0]), o or stat(100), r, a, s), [], op)
    out["shapes"] = [{"ty": "gr", "nm": nm, "hd": False, "it": items + [tr()]}
                     for nm, items in groups]
    return out


def sk(colour, width, dash=None):
    return stroke(colour, width * S, dash=dash)


def circle(cx, cy, r):
    return ellipse(2 * r * S, (cx * S, cy * S))


def oval(cx, cy, rx, ry):
    item = ellipse(2 * rx * S, (cx * S, cy * S))
    item["s"] = stat([2 * rx * S, 2 * ry * S])
    return item


def box(x, y, w, h, radius):
    return rect(w * S, h * S, radius * S, ((x + w / 2) * S, (y + h / 2) * S))


def shift(frames_dx, ease=TRAVEL, base=(0, 0)):
    """Layer position keys for a horizontal journey [(frame, dx[, 'hold'])]."""
    return keys([(e[0], u(base[0] + e[1], base[1])) + tuple(e[2:]) for e in frames_dx],
                dim=3, ease=ease)


# ════════════════════════════════════════════════════════════════════════════
# STRIP PARTS (272 x 32 points, 1360 x 160 canvas)
# ════════════════════════════════════════════════════════════════════════════

BADGE = (235.0, 10.0, 4.6)   # the lock badge circle the envelope stops at


def _flap_exit():
    """Where the flap's right stroke meets the badge circle."""
    (x0, y0), (x1, y1) = (227.5, 17.0), (235.2, 11.0)
    cx, cy, r = BADGE
    dx, dy = x1 - x0, y1 - y0
    fx, fy = x0 - cx, y0 - cy
    a, b, c = dx * dx + dy * dy, 2 * (fx * dx + fy * dy), fx * fx + fy * fy - r * r
    t = (-b - math.sqrt(b * b - 4 * a * c)) / (2 * a)
    return x0 + t * dx, y0 + t * dy


def phone(ind, op, o=None):
    return lay(ind, "ink", [("phone", [box(4, 1, 20, 30, 4), sk(WHITE, 1.6)])], op, o=o)


def homebar(ind, op, o=None):
    return lay(ind, "ink3", [("homebar", path("M11.5 28.2H16.5", S) + [sk(GREY, 1.2)])], op, o=o)


def line(ind, op, o=None, dash=None):
    """The line to the model end, broken around the gateway ring (the ring
    never moves, so a break replaces the board's knockout fill)."""
    return lay(ind, "ink3", [
        ("line", path("M28 16H129.5M136.5 16H236", S) + [sk(GREY, 1.2, dash)]),
        ("ring", [circle(133, 16, 3.5), sk(GREY, 1.2)]),
    ], op, o=o)


def bars(ind, op, o=None):
    return lay(ind, "ink", [("bars", path("M9 10H19M9 15H16.5M9 20H18", S) + [sk(WHITE, 1.6)])],
               op, o=o)


def cipher(ind, op, o=None):
    """The bars as cipher dots: 1.4 long every 3, the board's dasharray."""
    d = ""
    for y, x0, x1 in ((10, 9, 19), (15, 9, 16.5), (20, 9, 18)):
        x = x0
        while x < x1:
            d += f"M{x} {y}H{min(x + 1.4, x1)}"
            x += 3
    return lay(ind, "ink", [("cipher", path(d, S) + [sk(WHITE, 1.6)])], op, o=o)


def key(ind, op, p=None, o=None):
    return lay(ind, "accent", [("key", [circle(31, 16, 3)] + path("M34 16h9M40 16v3M43 16v2.5", S)
                                + [sk(ACCENT, 1.8)])], op, p=p, o=o)


def letter(ind, op, p=None, o=None):
    """The sealed letter: an envelope whose outline and flap stop at the lock
    badge, and the lock body. The shackle is its own layer (it opens)."""
    ex, ey = _flap_exit()
    env = "M236 14.49V20a2 2 0 0 1-2 2H221a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2H230.4"
    return lay(ind, "accent", [
        ("letter", path(env, S) + [sk(ACCENT, 1.4)]),
        ("flap", path(f"M219.8 11L227.5 17L{ex:.3f} {ey:.3f}", S) + [sk(ACCENT, 1.2)]),
        ("lock", [box(232.6, 9.4, 4.8, 3.8, 0.9), fill(ACCENT)]),
    ], op, p=p, o=o)


SHACKLE_PIVOT = (233.3, 9.6)  # the shackle's left-bottom: it opens about this


def shackle(ind, op, p=None, o=None, r=None):
    px, py = SHACKLE_PIVOT
    return lay(ind, "accent", [("shackle", path("M233.3 9.6v-1.2a1.7 1.7 0 0 1 3.4 0v1.2", S)
                                + [sk(ACCENT, 1.1)])],
               op, p=p or stat(u(px, py)), o=o, r=r, a=[px * S, py * S, 0])


def letter_matte(ind, op, p=None, o=None):
    """The letter's silhouette, padded by half its stroke. It cuts the line
    and ring under the letter wherever the letter goes."""
    return matte(ind, [box(218.3, 9.3, 18.4, 13.4, 2.7), fill(WHITE), tr()],
                 ks(p or stat([0, 0, 0]), o or stat(100)), op)


def sealed(ind, op, p, o=None, shackle_p=None, shackle_r=None):
    """Letter, shackle, then the matte and the line it cuts, in that order:
    a matte source must sit directly above the layer it cuts."""
    px, py = SHACKLE_PIVOT
    if shackle_p is None:
        shackle_p = keys([(k["t"], [k["s"][0] + px * S, k["s"][1] + py * S, 0])
                          + (("hold",) if k.get("h") else ()) for k in p["k"]],
                         dim=3, ease=TRAVEL) if p.get("a") else stat(
            [p["k"][0] + px * S, p["k"][1] + py * S, 0])
    return [
        letter(ind(), op, p=p, o=o),
        shackle(ind(), op, p=shackle_p, o=o, r=shackle_r),
        letter_matte(ind(), op, p=p, o=o),
        matted(line(ind(), op)),
    ]


# ── chat-strip-phone · work on the phone only ───────────────────────────────
# The phone breathes; the line and ring sit at 35% (the app dims the mark).
def strip_phone():
    ind, op = Ind(), f(PHONE_S)
    breathe = keys([(0, [100]), (op // 2, [55]), (op, [100])])
    return op, [
        line(ind(), op, o=stat(35)),
        homebar(ind(), op, o=breathe),
        phone(ind(), op, o=breathe),
    ]


# ── chat-strip-attest · the key comes to the phone, once ────────────────────
def strip_attest():
    ind, op = Ind(), f(ATTEST_S)
    march = keys([(0, [0]), (op, [28 * S])], ease=LINEAR)   # 4 x 7: same picture at both ends
    return op, [
        key(ind(), op, p=shift([(0, 198), (op, 0)]),
            o=keys([(0, [0]), (round(op * 0.15), [100]), (op, [100])])),
        line(ind(), op, dash=(3 * S, 4 * S, march)),
        homebar(ind(), op),
        phone(ind(), op),
    ]


# ── chat-strip-secure · the message is sealed and sent, once ────────────────
def strip_secure():
    ind, op = Ind(), f(SECURE_S)
    c0, c1, seen = round(op * 0.10), round(op * 0.35), round(op * 0.45)
    p = shift([(0, -194, "hold"), (c1, -194), (op, 0)])
    o = keys([(0, [0], "hold"), (c1, [0]), (seen, [100]), (op, [100])])
    return op, sealed(ind, op, p, o) + [
        cipher(ind(), op, o=keys([(0, [0]), (c0, [0]), (c1, [100]), (op, [100])])),
        bars(ind(), op, o=keys([(0, [100]), (c0, [100]), (c1, [0]), (op, [0])])),
        homebar(ind(), op),
        phone(ind(), op),
    ]


# ── chat-strip-think · the letter rests by the model; the mark moves ────────
def strip_think():
    ind, op = Ind(), f(THINK_S)
    return op, sealed(ind, op, stat([0, 0, 0])) + [homebar(ind(), op), phone(ind(), op)]


# ── chat-strip-retry · the letter is sent again, once ───────────────────────
def strip_retry():
    ind, op = Ind(), f(RETRY_S)
    gone, jump = round(op * 0.12), round(op * 0.13)
    c1, seen = round(op * 0.35), round(op * 0.45)
    p = shift([(0, 0, "hold"), (jump, -194), (c1, -194), (op, 0)])
    o = keys([(0, [100]), (gone, [0], "hold"), (c1, [0]), (seen, [100]), (op, [100])])
    return op, sealed(ind, op, p, o) + [homebar(ind(), op), phone(ind(), op)]


# ── chat-strip-return · the reply comes back sealed and opens, once ─────────
def strip_return():
    ind, op = Ind(), f(RETURN_S)
    t = RETURN_TRAVEL_F
    px, py = SHACKLE_PIVOT
    p = shift([(0, 0), (t, -192), (op, -192)])
    sp = keys([(0, u(px, py)), (t, u(px - 192, py)), (op, u(px - 192 + 0.6, py - 1.4))],
              dim=3, ease=EASE_OUT)
    sr = keys([(0, [0]), (t, [0]), (op, [-30])], ease=EASE_OUT)
    return op, sealed(ind, op, p, shackle_p=sp, shackle_r=sr) + [homebar(ind(), op), phone(ind(), op)]


# ── chat-strip-device · the phone alone; its screen fills while loading ─────
# Frame 0 is the phone alone (preparing, thinking). The app plays the loop
# only during deviceLoading: the fill rises behind the mark and fades out.
def strip_device():
    ind, op = Ind(), f(DEVICE_S)
    bottom = u(14, 26)
    return op, [
        lay(ind(), "accent", [("fill", [box(7, 4, 14, 22, 1.5), fill(ACCENT, 25)])], op,
            p=stat(bottom), a=bottom,
            s=keys([(0, [100, 5, 100]), (round(op * 0.1), [100, 5, 100]),
                    (round(op * 0.6), [100, 100, 100]), (op, [100, 100, 100])], dim=3),
            o=keys([(0, [0]), (round(op * 0.1), [100]), (round(op * 0.8), [100]), (op, [0])])),
        homebar(ind(), op),
        phone(ind(), op),
    ]


# ════════════════════════════════════════════════════════════════════════════
# STEP GLYPHS (20 x 20 points, 100 x 100 canvas)
# Board loops are 1.2-1.6 s, under the 2 s loop floor, so each file holds
# two cycles; the two `alternate` ones hold one there-and-back.
# ════════════════════════════════════════════════════════════════════════════

def cycles(n, period, entries):
    """Repeat [(frame, value[, 'hold'])] n times, `period` frames apart."""
    out = []
    for c in range(n):
        for e in entries:
            if c > 0 and e[0] == 0:
                continue
            out.append((e[0] + c * period,) + tuple(e[1:]))
    return out


def ln(d, width=1.5):
    return path(d, S) + [sk(WHITE, width)]


def ac(d, width=1.6):
    return path(d, S) + [sk(ACCENT, width)]


def glyph_think():
    """The dots in the bubble light in turn: an accent dot fades in over each
    ink3 dot. Each pulse ends inside its cycle, so frame 0 is all ink3."""
    ind, period = Ind(), f(1.2)
    op = 2 * period
    lit = []
    for j, x in enumerate((6.8, 10, 13.2)):
        a = round(j * 0.2 * FR)
        pulse = [(0, [0])] + ([(a, [0])] if a else []) + [
            (a + f(0.3), [100]), (a + f(0.7), [0]), (period, [0])]
        o = keys(cycles(2, period, pulse))
        lit.append((f"dot-lit-{j + 1}", [circle(x, 9.2, 1.1), fill(ACCENT)], o))
    accent = lay(ind(), "accent", [(nm, items) for nm, items, _ in lit], op)
    for g, (_, _, o) in zip(accent["shapes"], lit):
        g["it"][-1]["o"] = o
    return op, [
        accent,
        lay(ind(), "ink3", [("dot", [circle(x, 9.2, 1.1) for x in (6.8, 10, 13.2)] + [fill(GREY)])], op),
        lay(ind(), "ink", [("bubble", ln("M4 4.5h12a2 2 0 0 1 2 2v5.5a2 2 0 0 1-2 2H9.5L6 17v-3H4"
                                          "a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z"))], op),
    ]


def glyph_skill():
    """A page turns in the guide, about the book's spine."""
    ind, period = Ind(), f(1.4)
    op = 2 * period
    at = lambda pct: round(period * pct)  # noqa: E731
    s = keys(cycles(2, period, [(0, [100, 100, 100]), (at(0.1), [100, 100, 100]),
                                (at(0.5), [-100, 100, 100]), (at(0.61), [100, 100, 100], "hold"),
                                (period, [100, 100, 100])]), dim=3)
    o = keys(cycles(2, period, [(0, [100]), (at(0.5), [100]), (at(0.6), [0]), (at(0.61), [0]),
                                (at(0.75), [100]), (period, [100])]))
    return op, [
        lay(ind(), "accent", [("page", ac("M10 5.5c1.6-1 3.5-1.2 5.5-.9V14"))], op,
            p=stat(u(10, 10)), a=u(10, 10), s=s, o=o),
        lay(ind(), "ink", [("book", ln("M10 5.5C8 4.2 5.5 4 3 4.5v10.5c2.5-.5 5-.3 7 1 2-1.3 4.5-1.5 7-1"
                                        "V4.5c-2.5-.5-5-.3-7 1zM10 5.5V16"))], op),
    ]


def lens(ind, op, cx, cy, r, handle, p):
    """A lens and the matte that cuts the lines under its glass."""
    return [
        lay(ind(), "accent", [("lens", [circle(cx, cy, r)] + ac(handle))], op, p=p),
        matte(ind(), [circle(cx, cy, r), fill(WHITE), tr()], ks(p, stat(100)), op),
    ]


def glyph_facts():
    """The lens slides over the stacked facts and back. The back card is drawn
    broken where the front card covers it."""
    ind, half = Ind(), f(1.4)
    op = 2 * half
    p = keys([(0, [0, 0, 0]), (half, [-6 * S, 0, 0]), (op, [0, 0, 0])], dim=3)
    back = "M4.5 10.5H4a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5h7a1.5 1.5 0 0 1 1.5 1.5V7"
    return op, lens(ind, op, 14, 13, 3, "M16.2 15.2L18.3 17.3", p) + [
        matted(lay(ind(), "ink", [("cards", ln(back) + [box(4.5, 7, 10, 7, 1.5)])], op)),
    ]


def glyph_place():
    """The pin lifts and settles while a ripple spreads under it. The ripple
    is invisible at each cycle's ends, where its size resets. The lift is 1.8,
    not the board's 2.5: at 2.5 the pin's top stroke leaves the 20pt box,
    which the board's SVG overflows but a LottieView clips."""
    ind, period = Ind(), f(1.2)
    op = 2 * period
    lift = keys(cycles(2, period, [(0, [0, 0, 0]), (round(period * 0.35), [0, -1.8 * S, 0]),
                                   (period, [0, 0, 0])]), dim=3)
    end = period - 2
    rs = keys(cycles(2, period, [(0, [40, 40, 100]), (end, [140, 140, 100], "hold"),
                                 (period, [40, 40, 100])]), dim=3, ease=EASE_OUT)
    ro = keys(cycles(2, period, [(0, [0]), (4, [100]), (end, [0]), (period, [0])]))
    pin = "M10 16s5-4.5 5-8.3A5 5 0 0 0 5 7.7C5 11.5 10 16 10 16z"
    return op, [
        lay(ind(), "accent", [("pin-dot", [circle(10, 7.8, 1.8), fill(ACCENT)])], op, p=lift),
        lay(ind(), "ink", [("pin", ln(pin))], op, p=lift),
        lay(ind(), "accent", [("ripple", [oval(10, 17.3, 3, 0.9), sk(ACCENT, 1.6)])], op,
            p=stat(u(10, 17.3)), a=u(10, 17.3), s=rs, o=ro),
    ]


def glyph_write():
    """A line is written on the card. Frame 0 shows it written; each cycle
    fades it, resets it while hidden and writes it again."""
    ind, period = Ind(), f(1.3)
    op = 2 * period
    end = keys(cycles(2, period, [(0, [100]), (8, [100], "hold"), (9, [0]), (10, [0]),
                                  (10 + round(period * 0.6), [100]), (period, [100])]))
    o = keys(cycles(2, period, [(0, [100]), (8, [0]), (10, [100]), (period, [100])]))
    return op, [
        lay(ind(), "accent", [("ink", path("M6 10.5h7", S) + [trim(0, end), sk(ACCENT, 1.6)])], op, o=o),
        lay(ind(), "ink", [("card", [box(3, 3, 13, 14, 2)] + ln("M6 7h7M6 14h4"))], op),
    ]


def glyph_remove():
    """The card slides out and comes back. Started from the board's 12% point
    so frame 0 shows the card at rest."""
    ind, period = Ind(), f(1.4)
    op = 2 * period
    at = lambda pct: round(period * pct)  # noqa: E731
    p = keys(cycles(2, period, [(0, [0, 0, 0]), (at(0.18), [0, 0, 0]), (at(0.68), [5 * S, 0, 0], "hold"),
                                (at(0.88), [0, 0, 0]), (period, [0, 0, 0])]), dim=3)
    o = keys(cycles(2, period, [(0, [100]), (at(0.18), [100]), (at(0.68), [0]),
                                (at(0.88), [0]), (period, [100])]))
    return op, [
        lay(ind(), "accent", [("mark", ac("M6 10h5"))], op, p=p, o=o),
        lay(ind(), "ink", [("card", [box(3, 4.5, 11, 11, 2), sk(WHITE, 1.5)])], op, p=p, o=o),
    ]


def glyph_ask():
    """The question mark bobs."""
    ind, period = Ind(), f(1.2)
    op = 2 * period
    p = keys(cycles(2, period, [(0, [0, 0, 0]), (period // 2, [0, -1.5 * S, 0]), (period, [0, 0, 0])]),
             dim=3)
    return op, [
        lay(ind(), "accent", [("q", ac("M7.8 8a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .8-1 1.5v.4")),
                              ("q-dot", [circle(10, 14.6, 0.9), fill(ACCENT)])], op, p=p),
        lay(ind(), "ink", [("ring", [circle(10, 10, 7.5), sk(WHITE, 1.5)])], op),
    ]


def glyph_web():
    """The lens sweeps across the globe and back."""
    ind, half = Ind(), f(1.6)
    op = 2 * half
    p = keys([(0, [0, 0, 0]), (half, [-7 * S, -5 * S, 0]), (op, [0, 0, 0])], dim=3)
    return op, lens(ind, op, 14.5, 14.5, 2.8, "M16.5 16.5L18.5 18.5", p) + [
        matted(lay(ind(), "ink", [("globe", [circle(9, 9, 6.5)]
                                   + ln("M2.5 9h13M9 2.5c-2.2 2.4-2.2 10.6 0 13M9 2.5c2.2 2.4 2.2 10.6 0 13"))],
                   op)),
    ]


STRIPS = {
    "chat-strip-phone": strip_phone,
    "chat-strip-attest": strip_attest,
    "chat-strip-secure": strip_secure,
    "chat-strip-think": strip_think,
    "chat-strip-retry": strip_retry,
    "chat-strip-return": strip_return,
    "chat-strip-device": strip_device,
}
STEPS = {
    "chat-step-think": glyph_think,
    "chat-step-skill": glyph_skill,
    "chat-step-facts": glyph_facts,
    "chat-step-place": glyph_place,
    "chat-step-write": glyph_write,
    "chat-step-remove": glyph_remove,
    "chat-step-ask": glyph_ask,
    "chat-step-web": glyph_web,
}

for name, build in STRIPS.items():
    frames, layers = build()
    w = 140 if name == "chat-strip-device" else 1360
    write(name, frames, layers, w, 160)
for name, build in STEPS.items():
    frames, layers = build()
    write(name, frames, layers, 100, 100)

for name, size in WRITTEN:
    print(f"{name + '.json':<28} {size:>7} bytes")
print(f"\n{len(WRITTEN)} files written to {OUT}")
