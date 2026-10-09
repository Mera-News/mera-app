#!/usr/bin/env bash
# Pure-move check for screen-hook moves (simplify wave, ruling R9).
#
# Fails when any REMOVED line in the diff is not re-added somewhere as a MOVED line, unless the
# line is blank, punctuation only, or part of an import. Git's own move detection decides what
# "moved" means (--color-moved=plain with allow-indentation-change), so a re-indented block counts
# as moved and a block with one changed line does not.
#
# Added lines are NOT checked: the new hook file and the `use<Screen>()` call are expected new code.
#
# Git never treats a block shorter than 20 alphanumeric characters as moved. That is why
# punctuation-only lines (`}`, `);`, `],`) are allowed: they can never be proven moved on their own.
#
# Usage:
#   scripts/check-pure-move.sh [<git-diff-args>...]   default: HEAD~1 HEAD
#   scripts/check-pure-move.sh --cached
#   scripts/check-pure-move.sh abc123 def456 -- components/custom/feed
#   scripts/check-pure-move.sh --self-test
# Exit 0 = pure move, 1 = violations (printed as <file>:<old line>: <content>).
set -euo pipefail

self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

self_test() {
  local tmp rc out
  tmp="$(mktemp -d)"
  trap "rm -rf '$tmp'" EXIT
  cd "$tmp"
  git init -q
  git config user.email self-test@example.com
  git config user.name self-test

  # (a) base: Screen.tsx with an import and a 15-line function.
  cat > Screen.tsx <<'EOF'
import { View } from 'react-native';

export function computeThing(items: Item[], weight: number) {
  const valid = items.filter((item) => item.value != null);
  const a = valid.reduce((sum, item) => sum + item.value, 0);
  const b = valid.length * weight;
  const combined = a + b;
  const average = valid.length > 0 ? combined / valid.length : 0;
  const sorted = [...valid].sort((x, y) => y.value - x.value);
  const top = sorted.slice(0, 3).map((item) => item.label);
  const labels = top.length > 0 ? top.join(', ') : 'none';
  const summary = `${labels} (${average.toFixed(2)})`;
  const flags = valid.map((item) => item.value > average);
  const aboveCount = flags.filter(Boolean).length;
  const ratio = valid.length > 0 ? aboveCount / valid.length : 0;
  return { summary, ratio, combined };
}

export function Screen() {
  return <View />;
}
EOF
  git add -A && git commit -qm base
  local base; base="$(git rev-parse HEAD)"

  # Writes useScreen.ts holding the function body re-indented by 2 spaces; $1 = awk filter on it.
  move_fn() {
    {
      echo "export function useScreen() {"
      git show "$base:Screen.tsx" | sed -n '3,17p' | awk "$1" | sed 's/^\(.\)/  \1/'
      echo "  return { computeThing };"
      echo "}"
    } > useScreen.ts
    {
      echo "import { View } from 'react-native';"
      echo "import { useScreen } from './useScreen';"
      echo
      echo "export function Screen() {"
      echo "  useScreen();"
      echo "  return <View />;"
      echo "}"
    } > Screen.tsx
  }

  run_case() { # name, expected rc, grep pattern or ''
    set +e; out="$(bash "$self" "$base" HEAD 2>&1)"; rc=$?; set -e
    if [ "$rc" -ne "$2" ]; then
      echo "self-test FAILED: case $1 exited $rc, expected $2"; echo "$out"; exit 1
    fi
    if [ -n "$3" ] && ! grep -Fq -- "$3" <<<"$out"; then
      echo "self-test FAILED: case $1 output lacks: $3"; echo "$out"; exit 1
    fi
  }

  # (b) pure move.
  git checkout -q -b arm-b
  move_fn '{print}'
  git add -A && git commit -qm move
  run_case "b pure move" 0 "pure-move check ok"

  # (c) planted non-move: one line inside the function changes while moving.
  git checkout -q -b arm-c "$base"
  move_fn '{sub(/a \+ b/, "a - b"); print}'
  git add -A && git commit -qm planted
  run_case "c planted edit" 1 "const combined = a + b;"

  # (d) deletion: two lines of the function are dropped, not moved.
  git checkout -q -b arm-d "$base"
  move_fn '!/const flags|const aboveCount/'
  git add -A && git commit -qm deletion
  run_case "d deletion" 1 "const aboveCount"

  echo "self-test ok (4 cases)"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi

[ "$#" -gt 0 ] || set -- HEAD~1 HEAD

diff_out="$(mktemp)"
trap 'rm -f "$diff_out"' EXIT
# Explicit colours so the parse does not depend on user config. A failing git aborts here (set -e).
git -c color.diff.old=red -c color.diff.oldMoved=blue -c color.diff.oldMovedAlternative=blue \
  -c color.diff.new=green -c color.diff.newMoved=cyan -c color.diff.newMovedAlternative=cyan \
  diff --color=always --color-moved=plain --color-moved-ws=allow-indentation-change \
  --ws-error-highlight=none --no-ext-diff --src-prefix=a/ --dst-prefix=b/ "$@" > "$diff_out"

# Escapes git emitted (probed on git 2.54): removed = ESC[31m-..., moved removed = ESC[34m-...,
# hunk header = ESC[36m@@ ..., file headers = ESC[1m--- a/... ; context lines are uncoloured.
awk -v esc="$(printf '\033')" '
function plain(s) { gsub(esc "\\[[0-9;]*m", "", s); return s }
/^/ {
  raw = $0; p = plain(raw)
  if (p ~ /^diff --git /) { inhunk = 0; inblock = 0; next }
  if (!inhunk) {
    if (p ~ /^--- a\//) file = substr(p, 7)
    else if (p ~ /^\+\+\+ b\//) file = substr(p, 7)
    else if (p ~ /^@@ -[0-9]+/) {
      match(p, /-[0-9]+/); old = substr(p, RSTART + 1, RLENGTH - 1) + 0; inhunk = 1; inblock = 0
    }
    next
  }
  if (p ~ /^@@ -[0-9]+/) { match(p, /-[0-9]+/); old = substr(p, RSTART + 1, RLENGTH - 1) + 0; inblock = 0; next }
  c = substr(p, 1, 1)
  if (c == "" || c == " ") { old++; inblock = 0; next }
  if (c != "-") next            # added lines and "\ No newline" are not checked
  content = substr(p, 2); n = old++
  # Import tracking (also advances on moved lines so a block stays consistent).
  imp = 0
  if (inblock) { imp = 1; if (content ~ /^[[:space:]]*}[[:space:]]*from[[:space:]]+[\047"]/) inblock = 0 }
  else if (content ~ /^[[:space:]]*import[[:space:]]/ || content ~ /^[[:space:]]*import[\047"]/) {
    imp = 1
    if (content !~ /from[[:space:]]+[\047"]/ && content !~ /^[[:space:]]*import[[:space:]]*[\047"]/ && content !~ /;[[:space:]]*$/) inblock = 1
  }
  else if (content ~ /^[[:space:]]*}[[:space:]]*from[[:space:]]+[\047"]/) imp = 1
  if (index(raw, esc "[34m-") == 1) { moved++; next }
  if (imp || content ~ /^[][{}();,[:space:]]*$/) { allowed++; next }
  printf "%s:%d: %s\n", file, n, content; bad++
}
END {
  if (bad > 0) { printf "pure-move check FAILED: %d removed line(s) not re-added as moved\n", bad; exit 1 }
  printf "pure-move check ok (%d moved removals, %d allowed)\n", moved + 0, allowed + 0
}' "$diff_out"
