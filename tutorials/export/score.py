# -*- coding: utf-8 -*-
"""Soundtrack for an exported tutorial film, written on the film's own beat grid.

    python3 score.py <out.wav> <total_ms> <cut_ms,cut_ms,...>

100 BPM (tutorials/film/timeline.ts), A minor: a soft pad on Am F C G, a sub on
beats 1 and 3, a quiet kick from bar 2, off-beat ticks, and a pluck in the chord
on every cut. Everything sits on one grid counted from frame 0; the mix is kept
low and soft so the cuts read as part of the music. Pure standard library.
"""
import math
import random
import struct
import sys
import wave

SR = 44100
BPM = 100
BEAT = 60.0 / BPM
BAR = 4 * BEAT

out, total_ms, cuts = sys.argv[1], float(sys.argv[2]), [float(c) / 1000 for c in sys.argv[3].split(',')]
dur = total_ms / 1000
n = int(dur * SR)
L = [0.0] * n
R = [0.0] * n

A3 = 220.0
semi = lambda st: A3 * 2 ** (st / 12)
# Am, F, C, G as semitones from A3; one chord per bar.
CHORDS = [(0, 3, 7), (-4, 0, 3), (3, 7, 10), (-2, 2, 5)]
ROOTS = [0, -4, 3, -2]


def chord_at(t):
    return int(t // BAR) % 4


def add(buf, start, samples, gain):
    i0 = int(start * SR)
    for j, v in enumerate(samples):
        i = i0 + j
        if i >= n:
            break
        buf[i] += v * gain


def env(length, attack, release):
    a, r = int(attack * SR), int(release * SR)
    m = int(length * SR)
    return [min(1.0, j / a if a else 1.0, (m - j) / r if r else 1.0) for j in range(m)]


# Pad: two detuned saws per note through a one-pole low-pass, a bar per chord, slow swells.
bars = int(math.ceil(dur / BAR))
for b in range(bars):
    start = b * BAR
    length = min(BAR + 0.4, dur - start)
    if length <= 0:
        break
    e = env(length, 0.6, 0.8)
    for side, buf, detune in ((0, L, 0.998), (1, R, 1.002)):
        lp = 0.0
        notes = [semi(st) * detune for st in CHORDS[b % 4]]
        seg = []
        for j in range(len(e)):
            t = j / SR
            x = sum(2 * ((f * t) % 1.0) - 1 for f in notes) / 3
            lp += 0.035 * (x - lp)
            seg.append(lp * e[j])
        add(buf, start, seg, 0.16)

# Sub bass on beats 1 and 3, root an octave down.
beats = int(dur / BEAT)
for k in range(beats):
    if k % 2:
        continue
    t0 = k * BEAT
    f = semi(ROOTS[chord_at(t0)]) / 2
    e = env(BEAT * 1.6, 0.01, 0.5)
    sub = [math.sin(2 * math.pi * f * j / SR) * e[j] for j in range(len(e))]
    add(L, t0, sub, 0.22)
    add(R, t0, sub, 0.22)

# Soft kick on 1 and 3 from bar 2 to the last bar, which rings out with no drums.
last_bar = int((dur - 0.001) // BAR)
for k in range(4, beats):
    t0 = k * BEAT
    if k % 2 or t0 // BAR >= last_bar:
        continue
    m = int(0.28 * SR)
    ph = 0.0
    kick = []
    for j in range(m):
        f = 50 + 70 * math.exp(-j / (0.03 * SR))
        ph += 2 * math.pi * f / SR
        kick.append(math.sin(ph) * math.exp(-j / (0.09 * SR)))
    add(L, t0, kick, 0.30)
    add(R, t0, kick, 0.30)

# Off-beat ticks: high-passed noise, short and quiet, panned slightly.
rnd = random.Random(7)
for k in range(4, beats):
    t0 = k * BEAT + BEAT / 2
    if t0 // BAR >= last_bar:
        continue
    m = int(0.04 * SR)
    prev = 0.0
    tick = []
    for j in range(m):
        x = rnd.uniform(-1, 1)
        tick.append((x - prev) * math.exp(-j / (0.008 * SR)))
        prev = x
    add(L, t0, tick, 0.035)
    add(R, t0, tick, 0.05)

# Pluck on every cut (after the first frame): the chord's root, fifth and octave, bell-like.
for c in cuts[1:]:
    ch = CHORDS[chord_at(c)]
    m = int(1.6 * SR)
    pl = []
    for j in range(m):
        t = j / SR
        v = sum(math.sin(2 * math.pi * semi(st + 12) * t) * (0.6 if i else 1.0) for i, st in enumerate((ch[0], ch[2], ch[0] + 12)))
        pl.append(v / 2.2 * math.exp(-t / 0.35) * min(1.0, t / 0.004))
    add(L, c, pl, 0.10)
    add(R, c, pl, 0.12)

# Fade out over the last 1.2 s and normalise to a gentle peak.
fade = int(1.2 * SR)
for i in range(max(0, n - fade), n):
    g = (n - i) / fade
    L[i] *= g
    R[i] *= g
peak = max(max(abs(v) for v in L), max(abs(v) for v in R)) or 1.0
scale = 0.7 / peak

with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(b''.join(struct.pack('<hh', int(L[i] * scale * 32767), int(R[i] * scale * 32767)) for i in range(n)))
