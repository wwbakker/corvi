#!/usr/bin/env bash
#
# The test suite's runner: a run token, isolated roots, a cleanup trap, then `bun test`.
#
#   bash scripts/test-run.sh               # the unit files across workers, then the browser files one by one
#   bash scripts/test-run.sh unit          # everything but the browser end-to-end files
#   bash scripts/test-run.sh e2e           # the browser end-to-end files, one at a time
#   bash scripts/test-run.sh e2e-terminal  # the browser files named test/terminal*.test.ts
#   bash scripts/test-run.sh e2e-rest      # every other browser end-to-end file
#
# Any further arguments go to `bun test` (`--retry=2`, a file filter, …).
#
# A named mode whose group matched no test files exits 3 with a message on stderr; it never falls
# through to `bun test` with an empty argument list, which would run the whole suite instead.
#
# The terminal group is a naming convention, not a semantic one: browser files that merely drive
# terminal UI stay in the rest group.
#
# The token names everything the run makes — temp dirs, servers, hosts — so
# scripts/clean-test.ts can end a crashed run's leftovers without ever touching a suite in
# progress (its own documentation is the full story). The EXIT trap ends exactly this run's
# leftovers whatever the tests did.
set -euo pipefail

# A Corvi pane exports its own identity and log path. Scrub them so the suite is hermetic whether
# it is launched from a pane or a plain shell; each test sets the roots and identities it needs.
unset CORVI_LOG CORVI_SESSION_ID CORVI_SESSION_INCARNATION CORVI_CHANGE_ID CORVI_CHANGE_DIR CORVI_SUBAGENT_ID

mode="${1:-all}"
if [ "$#" -gt 0 ]; then shift; fi

CORVI_TEST_RUN="${CORVI_TEST_RUN:-$(date +%s).$$}"
export CORVI_TEST_RUN
echo $$ > "${TMPDIR:-/tmp}/corvi-$CORVI_TEST_RUN.pid"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/corvi-$CORVI_TEST_RUN-root-XXXXXX")
export CORVI_ROOT="$ROOT" CORVI_ARCHIVE_ROOT="$ROOT-archive" CORVI_CONFIG="$ROOT/config.json" XDG_STATE_HOME="$ROOT/state"
trap 'status=$?; bun scripts/clean-test.ts --kill --prune --run="$CORVI_TEST_RUN"; exit $status' EXIT

# The browser end-to-end files are the ones that import a Playwright browser at runtime; the rest
# run where no browser is installed. The list is derived from that import, so a new browser file
# cannot drift out of it (a helper that only names a Playwright type does not count).
#
# Those browser files split in two by name: the terminal group is the ones whose path matches
# `test/terminal*.test.ts`, the rest group is every other browser file. The glob is a naming
# convention, not a claim about what the test drives: browser files that merely exercise terminal
# UI (pages, the subagent change page) stay in the rest group.
e2e_terminal=()
e2e_rest=()
unit=()
while IFS= read -r found; do
  file="${found#./}"
  if grep -qE '^[[:space:]]*import[[:space:]]+\{[^}]*(chromium|webkit|firefox)[^}]*\}[[:space:]]*from[[:space:]]*"playwright"' "$found"; then
    case "$file" in
      test/terminal*.test.ts) e2e_terminal+=("$file") ;;
      *) e2e_rest+=("$file") ;;
    esac
  else
    unit+=("$file")
  fi
done < <(find . -name "*.test.ts" -not -path "./node_modules/*" | sort)

# One source of truth for the group sizes: the pre-build guards and the `all` composition both
# read these counts.
unit_count="${#unit[@]}"
e2e_terminal_count="${#e2e_terminal[@]}"
e2e_rest_count="${#e2e_rest[@]}"
e2e_count=$(( e2e_terminal_count + e2e_rest_count ))

# A named group with no files must fail here: an empty array expands to no arguments at all, and
# `bun test` with no arguments runs the whole suite — the opposite of the requested group.
require_files() {
  local group="$1" count="$2"
  if [ "$count" -eq 0 ]; then
    echo "scripts/test-run.sh: the $group group matched no test files" >&2
    exit 3
  fi
}

# Fail fast on an empty named group, before the web build pays for a run that cannot start. `all`
# composes whatever was found and stays unguarded.
case "$mode" in
  unit) require_files unit "$unit_count" ;;
  e2e) require_files e2e "$e2e_count" ;;
  e2e-terminal) require_files e2e-terminal "$e2e_terminal_count" ;;
  e2e-rest) require_files e2e-rest "$e2e_rest_count" ;;
esac

bun run build:web

# `--timings` orders the files slowest-first, so the longest ones start first and the workers
# finish together (bun's own file of measured durations, refreshed with --update-timings — in
# the `=` form of the flag, since a space-separated value is taken for a test-file filter
# instead).
timings=(--timings=scripts/timings.json)

# Two ways to run: everything but the browser files across CPU-count workers, and the end-to-end
# files one at a time — each of those starts servers and a browser, where a timing guess cannot
# turn three of them into a race for one runner's cores.
# Files across worker processes by default. A worker whose teardown stalls can leave the whole
# run hanging, so `CORVI_TEST_SERIAL=1` runs one process instead (CI does, where a hang is the
# job's five-minute timeout).
run_parallel() {
  if [ "${CORVI_TEST_SERIAL:-}" = "1" ]; then
    bun test --timeout 30000 "${timings[@]}" "$@"
  else
    bun test --timeout 30000 --parallel "${timings[@]}" "$@"
  fi
}
run_serial() { bun test --timeout 30000 "${timings[@]}" "$@"; }

# The e2e groups run as one serial shard wherever the full browser set is wanted; the `+`
# expansions keep a single empty group from tripping `set -u` on an older bash.
run_e2e() {
  run_serial ${e2e_terminal[@]+"${e2e_terminal[@]}"} ${e2e_rest[@]+"${e2e_rest[@]}"} "$@"
}

case "$mode" in
  unit) run_parallel ${unit[@]+"${unit[@]}"} "$@" ;;
  e2e) run_e2e "$@" ;;
  e2e-terminal) run_serial ${e2e_terminal[@]+"${e2e_terminal[@]}"} "$@" ;;
  e2e-rest) run_serial ${e2e_rest[@]+"${e2e_rest[@]}"} "$@" ;;
  all)
    # A pass-through argument is a filter or a flag (`--retry=2`), and the one-shot discovery is
    # what the caller asked for; the split below is the default, unfiltered suite.
    if [ "$#" -gt 0 ]; then
      run_parallel "$@"
      exit $?
    fi
    # Non-browser files first, across workers, then the browser end-to-end files one at a time.
    # Running them in one parallel sweep makes the e2e files contend with the rest for the
    # machine: a terminal file that passes in seconds isolated cascades under the load.
    if [ "$unit_count" -gt 0 ]; then
      if ! run_parallel "${unit[@]}"; then
        # Fail-fast stays, but silently never running the browser files reads as a green suite
        # that merely omitted them — say what happened and keep the unit shard's status.
        echo "the browser shard is skipped: the unit shard failed" >&2
        exit 1
      fi
    fi
    if [ "$e2e_count" -gt 0 ]; then
      run_e2e
    fi
    ;;
  *)
    echo "usage: scripts/test-run.sh [all|unit|e2e|e2e-terminal|e2e-rest] [bun test arguments...]" >&2
    exit 2
    ;;
esac
