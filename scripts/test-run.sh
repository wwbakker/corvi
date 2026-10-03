#!/usr/bin/env bash
#
# The test suite's runner: a run token, isolated roots, a cleanup trap, then `bun test`.
#
#   bash scripts/test-run.sh          # the unit files across workers, then the browser files one by one
#   bash scripts/test-run.sh unit     # everything but the browser end-to-end files
#   bash scripts/test-run.sh e2e      # only those (a browser and a real server each)
#
# Any further arguments go to `bun test` (`--retry=2`, a file filter, …).
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

bun run build:web

# The browser end-to-end files are the ones that import a Playwright browser at runtime; the rest
# run where no browser is installed. The list is derived from that import, so a new browser file
# cannot drift out of it (a helper that only names a Playwright type does not count).
e2e=()
unit=()
while IFS= read -r found; do
  file="${found#./}"
  if grep -qE '^[[:space:]]*import[[:space:]]+\{[^}]*(chromium|webkit|firefox)[^}]*\}[[:space:]]*from[[:space:]]*"playwright"' "$found"; then
    e2e+=("$file")
  else
    unit+=("$file")
  fi
done < <(find . -name "*.test.ts" -not -path "./node_modules/*" | sort)

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

case "$mode" in
  unit) run_parallel ${unit[@]+"${unit[@]}"} "$@" ;;
  e2e) run_serial ${e2e[@]+"${e2e[@]}"} "$@" ;;
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
    if [ "${#unit[@]}" -gt 0 ]; then
      run_parallel "${unit[@]}"
    fi
    if [ "${#e2e[@]}" -gt 0 ]; then
      run_serial "${e2e[@]}"
    fi
    ;;
  *)
    echo "usage: scripts/test-run.sh [all|unit|e2e] [bun test arguments...]" >&2
    exit 2
    ;;
esac
