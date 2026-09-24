#!/usr/bin/env bash
#
# The test suite's runner: a run token, isolated roots, a cleanup trap, then `bun test`.
#
#   bash scripts/test-run.sh          # everything there is
#   bash scripts/test-run.sh unit     # everything but the browser end-to-end files
#   bash scripts/test-run.sh e2e      # only those (a browser, a tmux and a real server each)
#
# Any further arguments go to `bun test` (`--retry=2`, a file filter, …).
#
# The token names everything the run makes — temp dirs, servers, tmux sockets — so
# scripts/clean-test.ts can end a crashed run's leftovers without ever touching a suite in
# progress (its own documentation is the full story). The EXIT trap ends exactly this run's
# leftovers whatever the tests did.
set -euo pipefail

mode="${1:-all}"
if [ "$#" -gt 0 ]; then shift; fi

CORVI_TEST_RUN="${CORVI_TEST_RUN:-$(date +%s).$$}"
export CORVI_TEST_RUN
echo $$ > "${TMPDIR:-/tmp}/corvi-$CORVI_TEST_RUN.pid"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/corvi-$CORVI_TEST_RUN-root-XXXXXX")
export CORVI_ROOT="$ROOT" CORVI_ARCHIVE_ROOT="$ROOT-archive" CORVI_CONFIG="$ROOT/config.json" XDG_STATE_HOME="$ROOT/state"
trap 'status=$?; bun scripts/clean-test.ts --kill --prune --run="$CORVI_TEST_RUN"; exit $status' EXIT

bun run build:web

# The browser end-to-end files, named so CI can give them their own job — and their own retries —
# while the rest of the suite runs where no browser is installed. Everything else is found by
# walking the workspaces, so a new test file needs no entry here — except a new *browser* file,
# which joins this list (they are found by their playwright import; this list is maintained
# beside it).
e2e=(test/terminal.test.ts test/pages.test.ts test/directoryPicker.page.test.ts test/plan.page.test.ts)
unit=()
while IFS= read -r found; do
  file="${found#./}"
  case " ${e2e[*]} " in
    *" ${file} "*) ;;
    *) unit+=("$file") ;;
  esac
done < <(find . -name "*.test.ts" -not -path "./node_modules/*" | sort)

case "$mode" in
  all) files=() ;; # discovery: every test file there is
  unit) files=("${unit[@]}") ;;
  e2e) files=("${e2e[@]}") ;;
  *)
    echo "usage: scripts/test-run.sh [all|unit|e2e] [bun test arguments...]" >&2
    exit 2
    ;;
esac

# `--timings` orders the files slowest-first, so the longest ones start first and the workers
# finish together (bun's own file of measured durations, refreshed with --update-timings — in
# the `=` form of the flag, since a space-separated value is taken for a test-file filter
# instead).
# The end-to-end files each start servers and a browser: one at a time, where a timing guess
# cannot turn three of them into a race for one runner's cores. Everything else runs across
# CPU-count workers.
timings=(--timings=scripts/timings.json)
# `all` passes no file list at all — discovery is every test file there is. The `[@]+` guard is
# what keeps a list empty rather than unbound on bash 3.2, where "${files[@]}" under `set -u` is
# an unbound variable.
if [ "$mode" = "e2e" ]; then
  exec bun test --timeout 30000 "${timings[@]}" ${files[@]+"${files[@]}"} "$@"
else
  exec bun test --timeout 30000 --parallel "${timings[@]}" ${files[@]+"${files[@]}"} "$@"
fi
