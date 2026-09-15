"""
The eighteen mera-news bodymovin pieces: six processing stages, twelve tutorial
chapter heroes.

Run it, then run `validate.py` over the output directory. Nothing is drawn by
hand and nothing is downloaded; every file is written straight against the
bodymovin schema through `lib_bodymovin.py`.

── The house style, decided once and applied to all eighteen ────────────────

These play over the app's abstract gradient backdrop on black, so the asset is
transparent and the composition has to hold against a field that is itself
moving slowly. That settles four things:

  * ONE chromatic colour, the accent, for the subject. Everything secondary is
    white at a low opacity, never a second hue. A third colour would read as a
    different app.
  * Calm and precise. Eased in and out, no bounce, no spin for its own sake.
    Nothing crosses the frame faster than about a third of the canvas a second.
  * The subject sits well inside the middle 70%, because a scene block is 200pt
    and contained. Most pieces here stay inside 200..800 rather than 150..850,
    which leaves the composition room to breathe rather than filling the box.
  * A tutorial hero has to read as its CHAPTER'S IDEA at 200pt, not as motion.
    Each one below carries the slide's own headline in a comment, because that
    headline is the brief and the piece is wrong if it does not say it back.
"""
import json
import os
import sys

from lib_bodymovin import (
    ACCENT, WHITE, CX, CY,
    comp, stat, keys, bell, dot, ring, bar, outline, tr, fill, stroke,
    ellipse, rect,
)

OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
os.makedirs(OUT, exist_ok=True)
WRITTEN = []


def write(name, frames, layers, fr=30):
    path = os.path.join(OUT, name + ".json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(comp(name, frames, layers, fr), fh, separators=(",", ":"))
    WRITTEN.append((name, os.path.getsize(path)))


class Ind:
    """Layer indices are 1-based and must be unique within a composition."""

    def __init__(self):
        self.n = 0

    def __call__(self):
        self.n += 1
        return self.n


# ════════════════════════════════════════════════════════════════════════════
# PROCESSING STAGES
# ════════════════════════════════════════════════════════════════════════════

# ── 1 · processing-fetching · "Finding today's news" ────────────────────────
# Signals arriving from the rim toward one soft centre. Abstract on purpose:
# this stage is two network round trips and a diff, and there is nothing
# literal to draw. Ten marks on ten radial lines, each fading up as it sets off
# and out as it lands, so the rim is never crowded and the boundary is empty.
def processing_fetching():
    import math
    ind = Ind()
    N, TOTAL = 96, 96
    layers = []
    layers.append(ring(ind(), "hub", 150, WHITE, 3, stat([CX, CY, 0]),
                       stat(26), stroke_op=100, op=TOTAL))
    layers.append(ring(ind(), "hub-core", 62, ACCENT, 0, stat([CX, CY, 0]),
                       stat(100), stroke_op=0, fill_colour=ACCENT,
                       fill_op=100, op=TOTAL,
                       scale=keys([(0, [100, 100, 100]), (48, [112, 112, 100]),
                                   (TOTAL, [100, 100, 100])], dim=3)))
    for i in range(10):
        ang = math.radians(i * 36 + 9)
        start = (i * 9) % 60
        end = start + 36
        r0, r1 = 300, 118
        layers.append(dot(
            ind(), f"signal-{i}", 34, ACCENT,
            keys([(start, [CX + r0 * math.cos(ang), CY + r0 * math.sin(ang), 0]),
                  (end, [CX + r1 * math.cos(ang), CY + r1 * math.sin(ang), 0])], dim=3),
            bell(start, start + 12, end - 8, end, high=92),
            op=TOTAL,
        ))
    return N, layers


# ── 2 · processing-downloading · "Downloading articles" ─────────────────────
# Articles landing on a shelf that is already partly full. The stack does NOT
# grow across the loop: each arriving card fades out as it meets the shelf and
# the resident rows hold, which is what lets frame 0 and frame N be the same
# picture without the pile visibly resetting.
def processing_downloading():
    ind = Ind()
    TOTAL = 102
    layers = []
    for i, y in enumerate((196, 250, 304)):
        layers.append(bar(ind(), f"shelf-{i}", 430, 26, 13, WHITE,
                          stat([CX, CY + y, 0]), stat(20), op=TOTAL))
    for i, y in enumerate((196, 250)):
        layers.append(bar(ind(), f"resident-{i}", 430, 26, 13, ACCENT,
                          stat([CX, CY + y, 0]), stat(58), op=TOTAL))
    # Every window ends inside TOTAL, opacity 0 at both of its own ends. A
    # window that runs past the last frame leaves a mark half-lit at the seam,
    # which is the one defect a still frame cannot show.
    for i, start in enumerate((0, 20, 40, 58)):
        end = start + 40
        layers.append(bar(
            ind(), f"falling-{i}", 430, 26, 13, ACCENT,
            keys([(start, [CX, CY - 250, 0]), (end, [CX, CY + 160, 0])], dim=3),
            bell(start, start + 10, end - 10, end, high=95),
            op=TOTAL,
        ))
    return TOTAL, layers


# ── 3 · processing-grouping · "Grouping duplicate stories" ──────────────────
# The spike's piece 1, re-authored with the travel windows pulled in so the
# whole sweep sits inside the safe box rather than grazing it: the original
# reached x 149..855 against an allowed 150..850, which the capture could not
# have caught and the validator does.
def processing_grouping():
    ind = Ind()
    TOTAL = 90
    CORES = [(-140, -60), (124, -92), (22, 108)]
    MARKS = [
        (-278, -200, 0, 0), (-312, 32, 0, 7), (-232, 166, 0, 14),
        (256, -208, 1, 3), (318, -16, 1, 10), (200, 186, 1, 17),
        (-92, 226, 2, 5), (108, 234, 2, 12), (6, -238, 2, 19),
    ]
    layers = []
    for i, (fx, fy, core, start) in enumerate(MARKS):
        tx, ty = CORES[core]
        end = start + 60
        layers.append(dot(
            ind(), f"mark-{i}", 44, ACCENT,
            keys([(start, [CX + fx, CY + fy, 0]), (end, [CX + tx, CY + ty, 0])], dim=3),
            bell(start, start + 22, start + 38, end, high=90),
            op=TOTAL,
        ))
    for i, (x, y) in enumerate(CORES):
        layers.append(ring(ind(), f"core-{i}", 164, WHITE, 2,
                           stat([CX + x, CY + y, 0]), stat(100),
                           stroke_op=100, fill_colour=ACCENT, fill_op=16, op=TOTAL))
    return TOTAL, layers


# ── 4 · processing-analysing · "Analysing relevance" ────────────────────────
# A reading sweep crossing a field of articles, each one lighting as it passes
# and settling back. The field holds perfectly still: the stage is about
# attention moving over the set, not about the set changing.
def processing_analysing():
    ind = Ind()
    TOTAL = 96
    COLS, ROWS, STEP = 4, 4, 140
    x0 = CX - STEP * (COLS - 1) / 2
    y0 = CY - STEP * (ROWS - 1) / 2
    layers = []
    for r in range(ROWS):
        for c in range(COLS):
            layers.append(dot(ind(), f"rest-{r}{c}", 46, WHITE,
                              stat([x0 + c * STEP, y0 + r * STEP, 0]),
                              stat(16), op=TOTAL))
    layers.append(bar(ind(), "sweep", 8, 520, 4, ACCENT,
                      keys([(0, [CX - 250, CY, 0]), (48, [CX + 250, CY, 0]),
                            (TOTAL, [CX - 250, CY, 0])], dim=3),
                      keys([(0, [0]), (14, [55]), (34, [55]), (48, [0]),
                            (62, [55]), (82, [55]), (TOTAL, [0])]),
                      op=TOTAL))
    # A column lights when the sweep is over it, on the way out AND on the way
    # back, so both halves of the travel are doing the same work.
    for c in range(COLS):
        out_t = 6 + c * 12
        back_t = 54 + (COLS - 1 - c) * 12
        for r in range(ROWS):
            layers.append(dot(
                ind(), f"lit-{r}{c}", 46, ACCENT,
                stat([x0 + c * STEP, y0 + r * STEP, 0]),
                keys([(0, [0]), (out_t, [0]), (out_t + 8, [95]), (out_t + 20, [0]),
                      (back_t, [0]), (back_t + 8, [95]), (back_t + 20, [0]),
                      (TOTAL, [0])]),
                op=TOTAL,
            ))
    return TOTAL, layers


# ── 5 · processing-summarising · "Writing your notes" ───────────────────────
# Four lines writing themselves inside a note, left to right, with the writing
# head running ahead of each. The card outline holds; the lines are drawn by an
# x SCALE anchored at their left edge, which is how a fill gets a stroke's
# drawing-on beat without a trim path.
def processing_summarising():
    ind = Ind()
    TOTAL = 114
    LINES = [(0, 400), (1, 340), (2, 380), (3, 250)]
    LEFT = CX - 210
    layers = [outline(ind(), "note", 470, 400, 34, ACCENT, 6,
                      stat([CX, CY, 0]), stat(100), stroke_op=55,
                      fill_colour=ACCENT, fill_op=8, op=TOTAL)]
    for i, width in LINES:
        y = CY - 120 + i * 80
        start = 6 + i * 22
        end = start + 20
        # Anchored at the line's left edge: the rect is drawn to the RIGHT of
        # the layer origin, so scaling x from 0 grows it rightward.
        layers.append(bar(
            ind(), f"line-{i}", width, 22, 11, ACCENT,
            stat([LEFT, y, 0]),
            keys([(0, [0]), (start, [0]), (start + 4, [88]), (94, [88]), (TOTAL, [0])]),
            op=TOTAL, offset=(width / 2, 0),
            scale=keys([(start, [0, 100, 100]), (end, [100, 100, 100]),
                        (TOTAL, [100, 100, 100])], dim=3),
        ))
        layers.append(dot(
            ind(), f"head-{i}", 20, WHITE,
            keys([(start, [LEFT, y, 0]), (end, [LEFT + width, y, 0])], dim=3),
            keys([(start, [0]), (start + 4, [70]), (end - 3, [70]), (end, [0])]),
            op=TOTAL,
        ))
    return TOTAL, layers


# ── 6 · processing-preparing · "Preparing your feed" ────────────────────────
# Cards arriving from alternating sides and squaring up into a deck. The deck
# outline is already there, so the loop is cards joining an arrangement rather
# than an arrangement being built and torn down.
def processing_preparing():
    ind = Ind()
    TOTAL = 114
    SLOTS = [-180, -60, 60, 180]
    W = 440
    layers = []
    for i, y in enumerate(SLOTS):
        layers.append(outline(ind(), f"slot-{i}", W, 96, 26, WHITE, 3,
                              stat([CX, CY + y, 0]), stat(18), op=TOTAL))
    # A card comes in from beside and above its slot rather than from off the
    # canvas: a 440-wide card entering from CX+330 reaches x 1065, and the
    # contained 200pt block would letterbox it away entirely.
    for i, (y, start) in enumerate(zip(SLOTS, (0, 18, 36, 52))):
        end = start + 40
        dx = 100 if i % 2 == 0 else -100
        layers.append(outline(
            ind(), f"card-{i}", W, 96, 26, ACCENT, 5,
            keys([(start, [CX + dx, CY + y - 95, 0]), (end, [CX, CY + y, 0])], dim=3),
            bell(start, start + 12, end + 8, end + 18, high=96),
            stroke_op=100, fill_colour=ACCENT, fill_op=12, op=TOTAL,
        ))
    return TOTAL, layers


# ════════════════════════════════════════════════════════════════════════════
# TUTORIAL CHAPTER HEROES
# ════════════════════════════════════════════════════════════════════════════

# ── welcome-what · "A news app that starts with you" ────────────────────────
# Rings going OUT from one point, and stories at the rim brightening as each
# ring reaches them. "Starts at the other end" is the sentence, so the motion
# starts at the centre and travels outward, which is the opposite of every
# other piece here. No mark of any kind at the centre beyond a plain dot: the
# welcome chapter is pre-auth and must never show the mera logo, and the logo
# is a spotlight cone over a circle, so nothing cone-shaped appears.
def welcome_what():
    import math
    ind = Ind()
    TOTAL = 114
    layers = [dot(ind(), "you", 54, ACCENT, stat([CX, CY, 0]), stat(100), op=TOTAL)]
    for i in range(3):
        start = i * 26
        end = start + 60
        layers.append(ring(
            ind(), f"reach-{i}", 600, WHITE, 5, stat([CX, CY, 0]),
            keys([(start, [0]), (start + 14, [46]), (end - 18, [30]), (end, [0])]),
            stroke_op=100, op=TOTAL,
            scale=keys([(start, [10, 10, 100]), (end, [100, 100, 100]),
                        (TOTAL, [100, 100, 100])], dim=3),
        ))
    for i in range(6):
        ang = math.radians(i * 60 + 20)
        reach = 268
        x, y = CX + reach * math.cos(ang), CY + reach * math.sin(ang)
        lit = 14 + (i % 3) * 32
        layers.append(bar(
            ind(), f"story-{i}", 96, 30, 15, ACCENT, stat([x, y, 0]),
            keys([(0, [24]), (lit, [24]), (lit + 10, [92]), (lit + 34, [24]),
                  (TOTAL, [24])]),
            op=TOTAL,
        ))
    return TOTAL, layers


# ── facts-a-fact-is · "A fact is one true line" ─────────────────────────────
# Several faint lines, one of which is true and completes. The others never
# finish. That is the slide exactly: short, true, about your life.
def facts_a_fact_is():
    ind = Ind()
    TOTAL = 96
    LEFT = CX - 230
    layers = []
    for i, w in enumerate((300, 460, 200, 380)):
        y = CY - 210 + i * 100
        if i == 1:
            continue
        layers.append(bar(ind(), f"draft-{i}", w, 24, 12, WHITE,
                          stat([LEFT, y, 0]), stat(16), op=TOTAL,
                          offset=(w / 2, 0)))
    y = CY - 110
    W = 420
    layers.append(bar(
        ind(), "true-line", W, 30, 15, ACCENT, stat([LEFT, y, 0]),
        keys([(0, [0]), (10, [0]), (16, [96]), (78, [96]), (TOTAL, [0])]),
        op=TOTAL, offset=(W / 2, 0),
        scale=keys([(10, [0, 100, 100]), (44, [100, 100, 100]),
                    (TOTAL, [100, 100, 100])], dim=3),
    ))
    layers.append(dot(
        ind(), "head", 22, WHITE,
        keys([(10, [LEFT, y, 0]), (44, [LEFT + W, y, 0])], dim=3),
        keys([(10, [0]), (16, [78]), (40, [78]), (44, [0])]),
        op=TOTAL,
    ))
    return TOTAL, layers


# ── feed-two-lists · "Two lists, two jobs" ──────────────────────────────────
# One long column on the left, the same day in sections on the right, and one
# highlight travelling down the column while its counterpart block lights in
# step. Same stories, different shape, which is what the copy says.
def feed_two_lists():
    ind = Ind()
    TOTAL = 108
    LX, RX = CX - 175, CX + 175
    layers = []
    for i in range(5):
        y = CY - 200 + i * 100
        layers.append(bar(ind(), f"row-{i}", 240, 58, 18, WHITE,
                          stat([LX, y, 0]), stat(20), op=TOTAL))
    for i in range(4):
        x = RX - 78 + (i % 2) * 156
        y = CY - 84 + (i // 2) * 168
        layers.append(outline(ind(), f"block-{i}", 140, 140, 26, WHITE, 3,
                              stat([x, y, 0]), stat(20), op=TOTAL))
    for i in range(4):
        t = 8 + i * 24
        y = CY - 200 + i * 100
        x = RX - 78 + (i % 2) * 156
        by = CY - 84 + (i // 2) * 168
        layers.append(bar(ind(), f"row-lit-{i}", 240, 58, 18, ACCENT,
                          stat([LX, y, 0]),
                          keys([(0, [0]), (t, [0]), (t + 8, [90]),
                                (t + 22, [0]), (TOTAL, [0])]), op=TOTAL))
        layers.append(outline(ind(), f"block-lit-{i}", 140, 140, 26, ACCENT, 4,
                              stat([x, by, 0]),
                              keys([(0, [0]), (t + 4, [0]), (t + 12, [90]),
                                    (t + 26, [0]), (TOTAL, [0])]),
                              stroke_op=100, fill_colour=ACCENT, fill_op=14,
                              op=TOTAL))
    return TOTAL, layers


# ── teaching-two-thumbs · "Two thumbs" ──────────────────────────────────────
# Two controls, tapped in turn, each sending out one ring. No thumb glyph: the
# slide's point is that these are the fastest thing to tap and the least useful
# alone, so what is drawn is the tapping, not the hand.
def teaching_two_thumbs():
    ind = Ind()
    TOTAL = 102
    PADS = [(CX - 150, 6), (CX + 150, 54)]
    layers = []
    for i, (x, t) in enumerate(PADS):
        layers.append(outline(
            ind(), f"pad-{i}", 200, 200, 46, ACCENT, 6, stat([x, CY, 0]),
            stat(100), stroke_op=100, fill_colour=ACCENT, fill_op=12, op=TOTAL,
            scale=keys([(0, [100, 100, 100]), (t, [100, 100, 100]),
                        (t + 6, [91, 91, 100]), (t + 18, [100, 100, 100]),
                        (TOTAL, [100, 100, 100])], dim=3),
        ))
        layers.append(bar(ind(), f"mark-{i}", 92, 16, 8, ACCENT,
                          stat([x, CY, 0]), stat(88), op=TOTAL))
        layers.append(ring(
            ind(), f"ripple-{i}", 200, WHITE, 5, stat([x, CY, 0]),
            keys([(0, [0]), (t + 4, [0]), (t + 10, [52]), (t + 38, [0]),
                  (TOTAL, [0])]),
            stroke_op=100, op=TOTAL,
            scale=keys([(t + 4, [100, 100, 100]), (t + 38, [168, 168, 100]),
                        (TOTAL, [168, 168, 100])], dim=3),
        ))
    return TOTAL, layers


# ── privacy-stays-on-phone · "The part about you never leaves" ──────────────
# The spike's piece 2, which the device capture confirmed reads as a phone
# holding things that stay inside it. Unchanged but for the safe-box shrink the
# spike itself had already applied.
def privacy_stays_on_phone():
    ind = Ind()
    TOTAL = 96
    PH_W, PH_H = 386, 680
    layers = [outline(ind(), "phone", PH_W, PH_H, 66, ACCENT, 7,
                      stat([CX, CY, 0]), stat(100), stroke_op=100,
                      fill_colour=ACCENT, fill_op=14, op=TOTAL)]
    layers.append(bar(ind(), "speaker", 110, 17, 9, ACCENT,
                      stat([CX, CY - PH_H / 2 + 34, 0]), stat(45), op=TOTAL))
    RESIDENTS = [(0, -170, 78, 0), (-70, 20, 62, 112), (80, 70, 66, 205),
                 (-30, 196, 72, 300), (50, -60, 52, 58)]
    for i, (ox, oy, r, a0) in enumerate(RESIDENTS):
        layers.append(dot(
            ind(), f"resident-{i}", 40, ACCENT,
            stat([CX + ox, CY + oy, 0]), stat(85),
            rot=keys([(0, [a0]), (TOTAL, [a0 + 360])]),
            offset=(0, -r), op=TOTAL,
        ))
    # The one mark that runs at the boundary from inside and turns back.
    layers.append(dot(
        ind(), "returning", 38, WHITE,
        keys([(0, [CX, CY + 40, 0]), (48, [CX, CY - 226, 0]),
              (TOTAL, [CX, CY + 40, 0])], dim=3),
        keys([(0, [80]), (48, [12]), (TOTAL, [80])]),
        op=TOTAL,
    ))
    return TOTAL, layers


# ── following-what-it-is · "For stories that are not over" ──────────────────
# A rail with developments already on it, a new one arriving, and the right end
# deliberately open. An election, a trial, a storm: the line does not finish.
def following_what_it_is():
    ind = Ind()
    TOTAL = 108
    RAIL_Y = CY + 150
    X0, X1 = CX - 280, CX + 280
    # Card heights alternate so the piece has vertical body: a rail alone reads
    # as a 160pt-tall sliver inside a 200pt contained block, which at that size
    # is a line rather than a timeline.
    NODES = [(X0 + 40, 130), (X0 + 170, 230), (X0 + 300, 160), (X0 + 430, 270)]
    layers = [bar(ind(), "rail", 560, 8, 4, WHITE, stat([CX, RAIL_Y, 0]),
                  stat(22), op=TOTAL)]
    for i, (x, h) in enumerate(NODES):
        layers.append(bar(ind(), f"tick-{i}", 6, h, 3, WHITE,
                          stat([x, RAIL_Y - h / 2, 0]), stat(16), op=TOTAL))
        layers.append(outline(ind(), f"card-{i}", 108, 74, 20, ACCENT, 5,
                              stat([x, RAIL_Y - h - 37, 0]), stat(78),
                              stroke_op=100, fill_colour=ACCENT, fill_op=12,
                              op=TOTAL))
        layers.append(dot(ind(), f"node-{i}", 46, ACCENT,
                          stat([x, RAIL_Y, 0]), stat(80), op=TOTAL))
    # The read-head passes each node in turn: every new development gathering
    # in one place instead of arriving scattered.
    layers.append(dot(
        ind(), "head", 88, ACCENT,
        keys([(0, [NODES[0][0], RAIL_Y, 0]), (78, [X1 - 30, RAIL_Y, 0])], dim=3),
        keys([(0, [0]), (14, [30]), (62, [30]), (78, [0]), (TOTAL, [0])]),
        op=TOTAL,
    ))
    for i, (x, h) in enumerate(NODES):
        t = 10 + i * 18
        layers.append(ring(
            ind(), f"pulse-{i}", 46, ACCENT, 5, stat([x, RAIL_Y, 0]),
            keys([(0, [0]), (t, [0]), (t + 8, [80]), (t + 34, [0]), (TOTAL, [0])]),
            stroke_op=100, op=TOTAL,
            scale=keys([(t, [100, 100, 100]), (t + 34, [230, 230, 100]),
                        (TOTAL, [230, 230, 100])], dim=3),
        ))
    # The open end. The story is not over, so one more arrives from past the
    # last node and the rail does not finish.
    layers.append(dot(
        ind(), "next", 46, ACCENT,
        keys([(56, [X1 + 10, RAIL_Y, 0]), (96, [X0 + 540, RAIL_Y, 0])], dim=3),
        bell(56, 70, 88, 96, high=92), op=TOTAL,
    ))
    return TOTAL, layers


# ── explore-unscored-on-purpose · "Deliberately not about you" ──────────────
# A grid that refuses to react. A sweep crosses it and NOTHING reorders, nothing
# is kept, every tile ends exactly as it started. The piece is about the absence
# of a response, so the only motion is the thing passing through.
def explore_unscored_on_purpose():
    ind = Ind()
    TOTAL = 96
    STEP = 180
    layers = []
    for r in range(3):
        for c in range(3):
            layers.append(outline(
                ind(), f"tile-{r}{c}", 150, 150, 30, WHITE, 4,
                stat([CX + (c - 1) * STEP, CY + (r - 1) * STEP, 0]),
                stat(30), op=TOTAL,
            ))
    layers.append(bar(
        ind(), "pass", 10, 560, 5, ACCENT,
        keys([(0, [CX - 330, CY, 0]), (48, [CX + 330, CY, 0]),
              (TOTAL, [CX - 330, CY, 0])], dim=3),
        keys([(0, [0]), (12, [46]), (36, [46]), (48, [0]), (60, [46]),
              (84, [46]), (TOTAL, [0])]),
        op=TOTAL,
    ))
    # One accent frame around the whole block: the country's own order, kept.
    layers.append(outline(
        ind(), "as-given", 560, 560, 56, ACCENT, 5, stat([CX, CY, 0]),
        keys([(0, [30]), (48, [64]), (TOTAL, [30])]), stroke_op=100, op=TOTAL,
    ))
    return TOTAL, layers


# ── sources-where-it-lives · "Two doors, one screen" ────────────────────────
# Two doors, opened in turn. Literal, because the copy is literal, and a door
# opening is the one gesture that says "there is more behind this than the
# screen shows".
def sources_where_it_lives():
    ind = Ind()
    TOTAL = 114
    W, H = 250, 430
    DOORS = [(CX - 150, 6, 1), (CX + 150, 60, -1)]
    layers = []
    for i, (x, t, hinge) in enumerate(DOORS):
        # Light behind the door, revealed as it swings.
        layers.append(bar(ind(), f"behind-{i}", W - 30, H - 30, 20, ACCENT,
                          stat([x, CY, 0]),
                          keys([(0, [0]), (t, [0]), (t + 12, [34]),
                                (t + 34, [34]), (t + 46, [0]), (TOTAL, [0])]),
                          op=TOTAL))
        # Anchored on its hinge edge, so an x scale swings it rather than
        # shrinking it about the middle.
        layers.append(outline(
            ind(), f"door-{i}", W, H, 22, ACCENT, 6,
            stat([x - hinge * W / 2, CY, 0]), stat(100), stroke_op=100,
            fill_colour=ACCENT, fill_op=10, op=TOTAL, offset=(hinge * W / 2, 0),
            scale=keys([(0, [100, 100, 100]), (t, [100, 100, 100]),
                        (t + 14, [26, 100, 100]), (t + 32, [26, 100, 100]),
                        (t + 48, [100, 100, 100]), (TOTAL, [100, 100, 100])], dim=3),
        ))
        layers.append(dot(ind(), f"handle-{i}", 22, WHITE,
                          stat([x + hinge * (W / 2 - 34), CY, 0]),
                          keys([(0, [70]), (t + 10, [0]), (t + 40, [0]),
                                (t + 52, [70]), (TOTAL, [70])]), op=TOTAL))
    return TOTAL, layers


# ── filters-three-shelves · "Three shelves on one screen" ───────────────────
# Three shelves, and things being put away on them. Everything you have asked
# Mera to keep back is the copy, so the marks travel DOWNWARD out of view and
# settle, rather than being thrown away.
def filters_three_shelves():
    ind = Ind()
    TOTAL = 114
    SHELF_Y = (CY - 190, CY + 10, CY + 210)
    layers = []
    for i, y in enumerate(SHELF_Y):
        layers.append(bar(ind(), f"shelf-{i}", 520, 8, 4, WHITE,
                          stat([CX, y + 52, 0]), stat(24), op=TOTAL))
    RESIDENTS = ((0, -170), (0, -80), (1, -160), (2, -200), (2, -110), (2, -20))
    for i, (shelf, dx) in enumerate(RESIDENTS):
        layers.append(bar(ind(), f"kept-{i}", 76, 76, 20, ACCENT,
                          stat([CX + dx, SHELF_Y[shelf] + 10, 0]),
                          stat(44), op=TOTAL))
    ARRIVING = ((0, 20, 0), (1, -60, 22), (2, 90, 44), (1, 60, 62))
    for i, (shelf, dx, start) in enumerate(ARRIVING):
        end = start + 34
        layers.append(bar(
            ind(), f"arriving-{i}", 76, 76, 20, ACCENT,
            keys([(start, [CX + dx, CY - 290, 0]),
                  (end, [CX + dx, SHELF_Y[shelf] + 10, 0])], dim=3),
            bell(start, start + 10, end + 6, end + 14, high=95), op=TOTAL,
        ))
    return TOTAL, layers


# ── signal-the-dial · "It is a floor: stories below it are not drawn" ───────
# The clearest of the twelve, because the copy gives it the mechanism outright.
# A line rises and falls; marks below the line stop being drawn and come back
# when it drops. Nothing is deleted, they are simply not on screen, which is
# exactly what the chip does.
def signal_the_dial():
    ind = Ind()
    TOTAL = 114
    XS = (-240, -144, -48, 48, 144, 240)
    HEIGHTS = (-40, 140, -190, 60, -110, 190)     # y, smaller is higher
    FLOOR = [(0, 40), (38, -140), (76, -140), (TOTAL, 40)]
    layers = []
    for i, (x, y) in enumerate(zip(XS, HEIGHTS)):
        layers.append(bar(ind(), f"col-{i}", 10, 460, 5, WHITE,
                          stat([CX + x, CY, 0]), stat(12), op=TOTAL))

    def visible_at(frame_y, mark_y):
        return 92 if mark_y <= frame_y else 10

    for i, (x, y) in enumerate(zip(XS, HEIGHTS)):
        kfs = [(t, [visible_at(fy, y)]) for t, fy in FLOOR]
        layers.append(dot(ind(), f"mark-{i}", 64, ACCENT,
                          stat([CX + x, CY + y, 0]), keys(kfs), op=TOTAL))
    layers.append(bar(
        ind(), "floor", 580, 10, 5, ACCENT,
        keys([(t, [CX, CY + fy, 0]) for t, fy in FLOOR], dim=3),
        stat(100), op=TOTAL,
    ))
    layers.append(dot(
        ind(), "knob", 34, ACCENT,
        keys([(t, [CX + 300, CY + fy, 0]) for t, fy in FLOOR], dim=3),
        stat(100), op=TOTAL,
    ))
    return TOTAL, layers


# ── chat-where-mera-is · "The speech bubble next to the logo" ───────────────
# A speech bubble, thinking. The copy calls it easy to walk past and the most
# capable control in the app, so it sits still and breathes rather than
# demanding attention.
def chat_where_mera_is():
    ind = Ind()
    TOTAL = 90
    BW, BH = 520, 340
    BY = CY - 40
    layers = [outline(ind(), "bubble", BW, BH, 62, ACCENT, 7,
                      stat([CX, BY, 0]), stat(100), stroke_op=100,
                      fill_colour=ACCENT, fill_op=12, op=TOTAL,
                      scale=keys([(0, [100, 100, 100]), (44, [103, 103, 100]),
                                  (TOTAL, [100, 100, 100])], dim=3))]
    # The tail: a small square turned 45 degrees, tucked under the left corner.
    layers.append(bar(ind(), "tail", 84, 84, 14, ACCENT,
                      stat([CX - 150, BY + BH / 2 + 12, 0]), stat(100),
                      fill_op=12, rot=stat(45), op=TOTAL))
    layers.append(outline(ind(), "tail-edge", 84, 84, 14, ACCENT, 7,
                          stat([CX - 150, BY + BH / 2 + 12, 0]), stat(100),
                          stroke_op=100, op=TOTAL))
    for i in range(3):
        t = i * 12
        layers.append(dot(
            ind(), f"typing-{i}", 52, ACCENT,
            stat([CX - 96 + i * 96, BY, 0]),
            keys([(0, [34]), (t, [34]), (t + 10, [96]), (t + 24, [34]),
                  (TOTAL, [34])]),
            op=TOTAL,
        ))
    return TOTAL, layers


# ── protocol-one-screen · "Where the switches are" ──────────────────────────
# Three switches on one screen, thrown and thrown back. Two taps from anywhere
# is the copy, so the gesture is short and the state is obviously reversible.
def protocol_one_screen():
    ind = Ind()
    TOTAL = 108
    ROWS = [(CY - 180, 8), (CY, 34), (CY + 180, 60)]
    TRACK_W, TRACK_H = 300, 110
    THROW = TRACK_W / 2 - 55
    layers = [outline(ind(), "screen", 620, 620, 64, WHITE, 4,
                      stat([CX, CY, 0]), stat(18), op=TOTAL)]
    for i, (y, t) in enumerate(ROWS):
        layers.append(outline(ind(), f"track-{i}", TRACK_W, TRACK_H, 55,
                              ACCENT, 5, stat([CX + 90, y, 0]), stat(100),
                              stroke_op=70, fill_colour=ACCENT, fill_op=10,
                              op=TOTAL))
        layers.append(bar(ind(), f"label-{i}", 170, 22, 11, WHITE,
                          stat([CX - 190, y, 0]), stat(26), op=TOTAL))
        layers.append(dot(
            ind(), f"knob-{i}", 78, ACCENT,
            keys([(0, [CX + 90 - THROW, y, 0]), (t, [CX + 90 - THROW, y, 0]),
                  (t + 14, [CX + 90 + THROW, y, 0]),
                  (t + 38, [CX + 90 + THROW, y, 0]),
                  (t + 52, [CX + 90 - THROW, y, 0]),
                  (TOTAL, [CX + 90 - THROW, y, 0])], dim=3),
            stat(100), op=TOTAL,
        ))
    return TOTAL, layers


PIECES = {
    "processing-fetching": processing_fetching,
    "processing-downloading": processing_downloading,
    "processing-grouping": processing_grouping,
    "processing-analysing": processing_analysing,
    "processing-summarising": processing_summarising,
    "processing-preparing": processing_preparing,
    "welcome-what": welcome_what,
    "facts-a-fact-is": facts_a_fact_is,
    "feed-two-lists": feed_two_lists,
    "teaching-two-thumbs": teaching_two_thumbs,
    "privacy-stays-on-phone": privacy_stays_on_phone,
    "following-what-it-is": following_what_it_is,
    "explore-unscored-on-purpose": explore_unscored_on_purpose,
    "sources-where-it-lives": sources_where_it_lives,
    "filters-three-shelves": filters_three_shelves,
    "signal-the-dial": signal_the_dial,
    "chat-where-mera-is": chat_where_mera_is,
    "protocol-one-screen": protocol_one_screen,
}

for name, builder in PIECES.items():
    frames, layers = builder()
    write(name, frames, layers)

for name, size in WRITTEN:
    print(f"{name + '.json':<38} {size:>7} bytes")
print(f"\n{len(WRITTEN)} files written to {OUT}")
