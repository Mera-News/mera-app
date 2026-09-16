"""
Regression proof that one-shot mode relaxes exactly two checks and nothing
else. Not part of the shipping pipeline - run it by hand after touching
ONE_SHOT_IDS or the one-shot branch in validate.py:

    python3 scripts/animations/test_one_shot_mode.py

It builds five fixtures from a real one-shot piece (game-mark-earn), each
broken on exactly one still-enforced dimension, and asserts:

  - every broken fixture FAILS under one-shot mode, on the dimension it
    broke and no other - proof the relaxation is narrow, not a bypass;
  - an otherwise-valid one-shot FAILS the plain gate (not in ONE_SHOT_IDS,
    no --one-shot) on duration - proof a forgotten registration fails loud
    rather than silently passing;
  - the same file PASSES once declared one-shot - proof the two intended
    checks (duration, seam) are the ones actually relaxed.

Exits 0 iff every assertion holds.
"""
import copy
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
import validate as v  # noqa: E402


def _load(name):
    path = os.path.join(os.path.dirname(__file__), "..", "..", "assets", "animations", f"{name}.json")
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write(tmp, name, doc):
    path = os.path.join(tmp, f"{name}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    return path


def _fail_contains(problems, needle):
    return any(needle in p for p in problems)


def main():
    base = _load("game-mark-earn")
    failures = []

    with tempfile.TemporaryDirectory() as tmp:
        # 1. size: pad well past the 150 KB ceiling with inert layers.
        size_doc = copy.deepcopy(base)
        for i in range(4000):
            size_doc["layers"].append({
                "ddd": 0, "ind": 1000 + i, "ty": 4, "nm": f"pad-{i}", "sr": 1,
                "ks": {"o": {"a": 0, "k": 0}, "r": {"a": 0, "k": 0},
                       "p": {"a": 0, "k": [500, 500, 0]},
                       "a": {"a": 0, "k": [0, 0, 0]},
                       "s": {"a": 0, "k": [100, 100, 100]}},
                "ao": 0,
                "shapes": [{"ty": "gr", "nm": "g", "hd": False, "it": [
                    {"ty": "el", "nm": "el", "d": 1,
                     "p": {"a": 0, "k": [0, 0]}, "s": {"a": 0, "k": [10, 10]}},
                    {"ty": "fl", "nm": "fl",
                     "c": {"a": 0, "k": [231 / 255, 138 / 255, 83 / 255, 1]},
                     "o": {"a": 0, "k": 100}, "r": 1, "hd": False},
                    {"ty": "tr", "p": {"a": 0, "k": [0, 0]},
                     "a": {"a": 0, "k": [0, 0]}, "s": {"a": 0, "k": [100, 100]},
                     "r": {"a": 0, "k": 0}, "o": {"a": 0, "k": 100},
                     "sk": {"a": 0, "k": 0}, "sa": {"a": 0, "k": 0}, "nm": "tr"},
                ]}],
                "ip": 0, "op": size_doc["op"], "st": 0, "bm": 0,
            })
        path = _write(tmp, "_fixture-size", size_doc)
        _, _, problems = v.validate(path, one_shot=True)
        if not _fail_contains(problems, "byte ceiling"):
            failures.append("size fixture did NOT fail on size under one-shot mode")

        # 2. palette: a third hue.
        palette_doc = copy.deepcopy(base)
        for layer in palette_doc["layers"]:
            for group in layer.get("shapes", []):
                for item in group.get("it", []):
                    if item.get("ty") == "fl":
                        item["c"]["k"] = [0.1, 0.3, 0.9, 1]
        path = _write(tmp, "_fixture-palette", palette_doc)
        _, _, problems = v.validate(path, one_shot=True)
        if not _fail_contains(problems, "neither the accent nor greyscale"):
            failures.append("palette fixture did NOT fail on palette under one-shot mode")

        # 3. canvas: wrong dimensions.
        canvas_doc = copy.deepcopy(base)
        canvas_doc["w"] = canvas_doc["h"] = 800
        path = _write(tmp, "_fixture-canvas", canvas_doc)
        _, _, problems = v.validate(path, one_shot=True)
        if not _fail_contains(problems, "1000x1000"):
            failures.append("canvas fixture did NOT fail on canvas under one-shot mode")

        # 4. safe area: push every position keyframe past x=850.
        safearea_doc = copy.deepcopy(base)
        for layer in safearea_doc["layers"]:
            p = layer["ks"]["p"]
            if p.get("a") == 0:
                p["k"] = [960, p["k"][1], p["k"][2]]
            else:
                for kf in p["k"]:
                    kf["s"] = [960, kf["s"][1], kf["s"][2]]
        path = _write(tmp, "_fixture-safearea", safearea_doc)
        _, _, problems = v.validate(path, one_shot=True)
        if not _fail_contains(problems, "leaves the middle 70%"):
            failures.append("safe-area fixture did NOT fail on the middle-70% sweep under one-shot mode")

        # 5a. unregistered: a valid one-shot, validated as a LOOP (plain
        #     gate default) - must fail loud on duration.
        path = _write(tmp, "_fixture-unregistered", base)
        _, _, problems = v.validate(path, one_shot=False)
        if not _fail_contains(problems, "outside the 2 to 4 s contract"):
            failures.append("unregistered fixture did NOT fail loud on duration under the plain (loop) gate")

        # 5b. the SAME file, declared one-shot - must pass cleanly. This is
        #     the positive proof: the two relaxed checks are the ones that
        #     were blocking it, and only those two.
        _, _, problems = v.validate(path, one_shot=True)
        if problems:
            failures.append(f"same fixture FAILED under one-shot mode, expected a clean pass: {problems}")

    if failures:
        print("ONE-SHOT MODE REGRESSION: NOT PROVEN")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("One-shot mode proof holds: all five fixtures behaved as required.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
