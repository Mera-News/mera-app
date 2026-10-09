#!/usr/bin/env bash
# The serialized deletion gate (DECISIONS R3, R4). Run it once per deletion batch, BEFORE the
# deletion commit, with a file listing the test paths that batch replaces (repo-relative, one per
# line, # comments allowed). It never deletes or commits anything.
#
#   scripts/deletion-gate.sh <paths-file> [--out DIR] [--rev REV]
#
# Both runs happen in a throwaway detached worktree at REV (default HEAD), with node_modules
# symlinked, so other agents' uncommitted work in the shared tree can neither add nor break
# suites between run A and run B. Commit the replacing tests BEFORE running the gate.
#
# Run A: the whole suite under jest.gate.config.js with json-summary coverage. Run B: the same with
# GATE_EXCLUDE = the listed paths. Both must be green (a passing test.failing is green). Every file
# in both coverage summaries must keep its covered lines and covered branches; any drop fails. The
# harness-local type checks must not gain errors over scripts/deletion-gate.tsc-baseline. The last
# line is a summary for the deletion commit message.
#
# Holds one heavy slot per Jest/tsc run (../bin/heavy when present). Never run two at once.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
HEAVY="$ROOT/../bin/heavy"
[ -x "$HEAVY" ] || HEAVY=""
BASELINE="scripts/deletion-gate.tsc-baseline"  # read inside the worktree, so it is REV's

usage() { echo "usage: $0 <paths-file> [--out DIR] [--rev REV]" >&2; exit 2; }
[ $# -ge 1 ] || usage
LIST="$1"; shift
OUT="e2e-output/gate/$(date +%Y%m%d-%H%M%S)"
REV=HEAD
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?}"; shift ;;
    --rev) REV="${2:?}"; shift ;;
    *) usage ;;
  esac
  shift
done
[ -f "$LIST" ] || { echo "error: no such paths file: $LIST" >&2; exit 2; }
LIST="$(cd "$(dirname "$LIST")" && pwd)/$(basename "$LIST")"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
SHA="$(git rev-parse --verify "$REV^{commit}")"
WT="${TMPDIR:-/tmp}/mera-gate-$SHA-$$"
cleanup() { cd "$ROOT"; git worktree remove --force "$WT" > /dev/null 2>&1 || rm -rf "$WT"; }
trap cleanup EXIT
git worktree add --detach "$WT" "$SHA" > /dev/null
ln -s "$ROOT/node_modules" "$WT/node_modules"
cd "$WT"

# ---- (a) the listed paths ------------------------------------------------------------------
PATHS=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"; line="$(echo "$line" | tr -d '[:space:]')"
  [ -n "$line" ] && PATHS+=("$line")
done < "$LIST"
[ "${#PATHS[@]}" -gt 0 ] || { echo "error: $LIST lists no paths" >&2; exit 2; }
BAD=0
for p in "${PATHS[@]}"; do
  if [ ! -f "$p" ]; then echo "error: listed path does not exist at ${REV} ($SHA): $p" >&2; BAD=1
  elif ! [[ "$p" =~ \.(test|spec)\.[jt]sx?$ ]]; then echo "error: not a test file: $p" >&2; BAD=1
  fi
done
[ "$BAD" = 0 ] || exit 2
EXCLUDE="$(IFS=,; echo "${PATHS[*]}")"
echo "gate: ${#PATHS[@]} replaced test file(s) at $SHA, output in $OUT"

run_jest() { # <label> <coverage dir>
  local label="$1" dir="$2" rc=0
  echo "== run $label"
  ${HEAVY:+"$HEAVY"} npx jest -c jest.gate.config.js --coverage --coverageReporters=json-summary \
    --coverageDirectory="$dir" --maxWorkers=2 --json --outputFile="$dir.json" > "$dir.log" 2>&1 || rc=$?
  grep -E '^(Tests|Test Suites):' "$dir.log" || true
  return "$rc"
}

# ---- (b)-(d) the two runs ------------------------------------------------------------------
RC_A=0; RC_B=0
run_jest "A (as is)" "$OUT/before" || RC_A=$?
GATE_EXCLUDE="$EXCLUDE" run_jest "B (replaced tests excluded)" "$OUT/after" || RC_B=$?
[ "$RC_A" = 0 ] || echo "FAIL: run A is red (see $OUT/before.log)" >&2
[ "$RC_B" = 0 ] || echo "FAIL: run B is red (see $OUT/after.log)" >&2

# ---- (e)-(f) per-file coverage diff --------------------------------------------------------
COV_RC=0
SUMMARY="$(node - "$OUT/before/coverage-summary.json" "$OUT/after/coverage-summary.json" "$WT" <<'NODE'
const fs = require('fs');
const [a, b, root] = process.argv.slice(2);
if (!fs.existsSync(a) || !fs.existsSync(b)) { console.error('FAIL: a coverage summary is missing'); process.exit(1); }
const A = JSON.parse(fs.readFileSync(a, 'utf8')), B = JSON.parse(fs.readFileSync(b, 'utf8'));
const rel = (f) => f.startsWith(root + '/') ? f.slice(root.length + 1) : f;
const files = (S) => new Set(Object.keys(S).filter((k) => k !== 'total'));
const fa = files(A), fb = files(B);
const pct = (m) => (m.total === 0 ? 100 : (100 * m.covered) / m.total).toFixed(2);
let drops = 0, compared = 0;
for (const f of fa) {
  if (!fb.has(f)) continue;
  compared++;
  for (const metric of ['lines', 'branches']) {
    const x = A[f][metric], y = B[f][metric];
    if (y.covered < x.covered) {
      drops++;
      console.error(`DROP ${rel(f)} ${metric} ${pct(x)}% -> ${pct(y)}% (${x.covered}/${x.total} -> ${y.covered}/${y.total})`);
    }
  }
}
for (const f of fa) if (!fb.has(f)) console.error(`only in A: ${rel(f)}`);
for (const f of fb) if (!fa.has(f)) console.error(`only in B: ${rel(f)}`);
const t = (S, m) => S.total[m].pct.toFixed(2);
console.error(`totals: lines ${t(A, 'lines')}% -> ${t(B, 'lines')}%, branches ${t(A, 'branches')}% -> ${t(B, 'branches')}%`);
console.log(`coverage L ${t(A, 'lines')}->${t(B, 'lines')} B ${t(A, 'branches')}->${t(B, 'branches')}, ${compared} files compared, ${drops} drops`);
process.exit(drops > 0 ? 1 : 0);
NODE
)" || COV_RC=$?

# ---- (g) R4: harness-local type checks -----------------------------------------------------
TSC_RC=0
[ -f "$BASELINE" ] || { echo "FAIL: missing $BASELINE" >&2; exit 1; }
while read -r cfg base; do
  case "$cfg" in ''|\#*) continue ;; esac
  n=$( { ${HEAVY:+"$HEAVY"} npx tsc --noEmit -p "$cfg" 2>&1 || true; } | grep -c 'error TS' || true)
  if [ "$n" -gt "$base" ]; then echo "FAIL: tsc -p $cfg: $n errors, baseline $base" >&2; TSC_RC=1
  else echo "tsc -p $cfg: $n errors (baseline $base)"; fi
done < "$BASELINE"

# ---- (h) verdict -----------------------------------------------------------------------------
echo "$SUMMARY"
if [ "$RC_A" = 0 ] && [ "$RC_B" = 0 ] && [ "$COV_RC" = 0 ] && [ "$TSC_RC" = 0 ]; then
  echo "GATE PASS: $SUMMARY"
  exit 0
fi
echo "GATE FAIL: runA=$RC_A runB=$RC_B coverage=$COV_RC tsc=$TSC_RC ($SUMMARY)" >&2
exit 1
