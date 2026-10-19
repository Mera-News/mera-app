"""
Proof that the chat-family checks in validate.py can fail. Run it by hand
after touching validate.py or lib_bodymovin.py:

    python3 scripts/animations/test_chat_families.py

Every fixture is built here from the lib, so it needs no asset on disk. Each
NEGATIVE fixture breaks exactly one rule and must fail on that rule's message;
each POSITIVE control must pass cleanly, which proves the negatives fail for
the reason named and not for some other defect in the fixture.

Exits 0 iff every assertion holds.
"""
import copy
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
import validate as v  # noqa: E402
from lib_bodymovin import (  # noqa: E402
    ACCENT, WHITE, comp, stat, keys, layer, ks, path, stroke, fill, rect, tr, trim,
    matte, matted,
)

S = 5  # chat pieces are drawn at 5x their point size


def strip_doc(name="chat-strip-think", frames=120, op_keys=None):
    """A valid cloud strip: phone, line, and a letter cutting the line."""
    phone = layer(1, "ink", ks(stat([0, 0, 0]), op_keys or stat(100)),
                  [rect(20 * S, 30 * S, 4 * S, (14 * S, 16 * S)), stroke(WHITE, 1.6 * S), tr()],
                  frames, group="phone")
    letter = layer(2, "accent", ks(stat([0, 0, 0]), stat(100)),
                   path("M219 10h17v12h-17z", S) + [stroke(ACCENT, 1.4 * S), tr()],
                   frames, group="letter")
    cut = matte(3, [rect(17 * S, 12 * S, 2 * S, (227.5 * S, 16 * S)), fill(WHITE), tr()],
                ks(stat([0, 0, 0]), stat(100)), frames)
    line = matted(layer(4, "ink3", ks(stat([0, 0, 0]), stat(35)),
                        path("M28 16H236", S) + [stroke(WHITE, 1.2 * S), tr()],
                        frames, group="line"))
    return comp(name, frames, [letter, cut, line, phone], fr=60, w=1360, h=160)


def glyph_doc(name="chat-step-write", frames=156, end_keys=None):
    """A valid glyph: a card, and a line drawn on with a trim that closes."""
    card = layer(1, "ink", ks(stat([0, 0, 0]), stat(100)),
                 [rect(13 * S, 14 * S, 2 * S, (9.5 * S, 10 * S)), stroke(WHITE, 1.5 * S), tr()],
                 frames, group="card")
    end = end_keys or keys([(0, [100]), (20, [0], "hold"), (24, [0]), (90, [100]), (frames, [100])])
    ink = layer(2, "accent", ks(stat([0, 0, 0]), stat(100)),
                path("M6 10.5h7", S) + [trim(0, end), stroke(ACCENT, 1.6 * S), tr()],
                frames, group="ink")
    return comp(name, frames, [ink, card], fr=60, w=100, h=100)


def check(tmp, label, name, doc, needle, failures, one_shot=False):
    path_ = os.path.join(tmp, name + ".json")
    with open(path_, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    _, _, problems = v.validate(path_, one_shot=one_shot)
    if needle is None:
        if problems:
            failures.append(f"{label}: expected a clean pass, got {problems}")
    elif not any(needle in p for p in problems):
        failures.append(f"{label}: expected a failure containing {needle!r}, got {problems}")


def main():
    failures = []
    with tempfile.TemporaryDirectory() as tmp:
        # positive controls
        check(tmp, "valid strip", "chat-strip-think", strip_doc(), None, failures)
        check(tmp, "valid glyph", "chat-step-write", glyph_doc(), None, failures)

        # canvas per family, exact id ahead of the prefix
        bad = strip_doc()
        bad["w"] = bad["h"] = 1000
        check(tmp, "strip at 1000", "chat-strip-think", bad, "contract says 1360x160", failures)
        dev = comp("chat-strip-device", 120, [layer(
            1, "ink", ks(stat([0, 0, 0]), stat(100)),
            [rect(20 * S, 30 * S, 4 * S, (14 * S, 16 * S)), stroke(WHITE, 1.6 * S), tr()],
            120, group="phone")], fr=60, w=140, h=160)
        check(tmp, "device at 140", "chat-strip-device", dev, None, failures)
        wide = copy.deepcopy(dev)
        wide["w"] = 1360
        check(tmp, "device at 1360", "chat-strip-device", wide, "contract says 140x160", failures)

        # role names (a matte source is exempt, which the positive control proves)
        bad = strip_doc()
        bad["layers"][-1]["nm"] = "ink2"
        check(tmp, "layer named ink2", "chat-strip-think", bad, "not named ink, ink3 or accent", failures)

        # animated colour
        bad = strip_doc()
        st = bad["layers"][0]["shapes"][0]["it"][-2]
        st["c"] = keys([(0, ACCENT), (120, ACCENT)], dim=4)
        check(tmp, "animated colour", "chat-strip-think", bad, "animates a colour", failures)

        # model-end keep-out
        bad = strip_doc()
        bad["layers"].append(layer(9, "accent", ks(stat([0, 0, 0]), stat(100)),
                                   [rect(4 * S, 4 * S, 0, (246 * S, 16 * S)), fill(ACCENT), tr()],
                                   120, group="intruder"))
        check(tmp, "shape in model end", "chat-strip-think", bad, "draws into the model end", failures)

        # whole-canvas safe box, measured with half the stroke: the line's
        # geometry ends at 19.5 of 20, inside, but its 1.6 stroke does not
        bad = glyph_doc()
        bad["layers"][0]["shapes"][0]["it"][-1]["p"] = stat([6.5 * S, 0])
        check(tmp, "stroke past glyph edge", "chat-step-write", bad, "subject leaves the canvas", failures)

        # path extents count curve control points, not only vertices
        curve = glyph_doc()
        curve["layers"][0]["shapes"][0]["it"] = path("M3 10C3 -3 17 -3 17 10", S) + [
            stroke(WHITE, 1.5 * S), tr()]
        check(tmp, "curve control point off canvas", "chat-step-write", curve,
              "subject leaves the canvas", failures)

        # seam inside the shapes: a trim that does not close
        bad = glyph_doc(end_keys=keys([(0, [0]), (156, [100])]))
        check(tmp, "trim seam", "chat-step-write", bad, "does not close its loop", failures)

        # keyframe times must strictly increase
        bad = glyph_doc(end_keys=keys([(0, [100]), (0, [100]), (156, [100])]))
        check(tmp, "duplicate keyframe time", "chat-step-write", bad,
              "do not strictly increase", failures)

        # a chat-strip one-shot rests on its LAST frame
        fade_in = keys([(0, [0]), (120, [100])])
        fade_out = keys([(0, [100]), (120, [0])])
        doc_in = strip_doc("chat-strip-secure", op_keys=fade_in)
        for l in doc_in["layers"]:
            l["ks"]["o"] = fade_in
        check(tmp, "one-shot dark at frame 0", "chat-strip-secure", doc_in, None, failures, one_shot=True)
        doc_out = strip_doc("chat-strip-secure", op_keys=fade_out)
        for l in doc_out["layers"]:
            l["ks"]["o"] = fade_out
        check(tmp, "one-shot dark at its last frame", "chat-strip-secure", doc_out,
              "nothing is lit at frame 120", failures, one_shot=True)

    if failures:
        print("CHAT FAMILY CHECKS: NOT PROVEN")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("Chat family checks hold: every fixture behaved as required.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
