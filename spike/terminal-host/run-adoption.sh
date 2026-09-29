#!/usr/bin/env bash
#
# The adoption/update proof, driven as separate processes and asserted, under both runtimes Corvi
# ships: system Node and Electron's Node (ELECTRON_RUN_AS_NODE=1). Each runtime gets its own
# private socket dir.
#
#   open              a client starts the host, opens a shell, sees a marker, then exits
#   adopt             a *new* client attaches to the still-running host and the same shell
#   checkout mismatch a client with a different checkout replaces the host, not silently adopts
#   stale build       a client with a different build id replaces the host, not silently adopts
#
# Every host lives under this script's own temp dir; the trap shuts the current one down on any
# exit path.
set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(cd ../.. && pwd)"
ELECTRON="$REPO_ROOT/apps/desktop/node_modules/electron/dist/electron"
RUNTIME_BIN="node"
WORK=""
SOCKET=""
ASSERTIONS=0

cleanup() {
  if [ -n "$WORK" ] && [ -n "$RUNTIME_BIN" ]; then
    "$RUNTIME_BIN" prove.ts --phase cleanup --socket "$SOCKET" --build-id v2 >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup INT TERM EXIT

fail() { echo "ASSERT FAILED: $*" >&2; exit 1; }
assert_eq() { ASSERTIONS=$((ASSERTIONS + 1)); [ "$1" = "$2" ] || fail "$3 (got '$1', want '$2')"; }
assert_true() { ASSERTIONS=$((ASSERTIONS + 1)); [ "$1" = "true" ] || fail "$2 (got '$1')"; }
assert_alive() { ASSERTIONS=$((ASSERTIONS + 1)); kill -0 "$1" 2>/dev/null || fail "$2 (pid $1 is not alive)"; }
assert_dead() {
  ASSERTIONS=$((ASSERTIONS + 1))
  for _ in $(seq 1 100); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.02; done
  fail "$2 (pid $1 is still alive)"
}

pid_of() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).hostPid))' "$1"; }
field() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]]))' "$1" "$2"; }

run_phase() { # phase build marker [checkout]
  local phase="$1" build="$2" marker="${3:-NONE}" checkout="${4:-}"
  if [ -n "$checkout" ]; then
    "$RUNTIME_BIN" prove.ts --phase "$phase" --socket "$SOCKET" --build-id "$build" --marker "$marker" --checkout "$checkout"
  else
    "$RUNTIME_BIN" prove.ts --phase "$phase" --socket "$SOCKET" --build-id "$build" --marker "$marker"
  fi
}

for label in node electron; do
  echo "########## runtime: $label ##########"
  if [ "$label" = electron ]; then
    export ELECTRON_RUN_AS_NODE=1
    RUNTIME_BIN="$ELECTRON"
  else
    unset ELECTRON_RUN_AS_NODE
    RUNTIME_BIN="node"
  fi
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/corvi-spike-host-XXXXXX")"
  SOCKET="$WORK/host.sock"
  mkdir -p "$WORK/other-checkout"

  echo "== open (build v1) =="
  OUT="$(run_phase open v1 FIRST)"; echo "$OUT"
  P1="$(pid_of "$OUT")"
  assert_eq "$(field "$OUT" adopted)" "false" "open must start a fresh host"
  assert_true "$(field "$OUT" markerFound)" "open must see its marker"
  assert_alive "$P1" "host must outlive the client that started it"

  echo "== adopt (build v1, new client process) =="
  OUT="$(run_phase adopt v1 SECOND)"; echo "$OUT"
  assert_true "$(field "$OUT" adopted)" "adopt must reuse the running host"
  assert_eq "$(pid_of "$OUT")" "$P1" "adopt must reach the same host pid"
  assert_true "$(field "$OUT" markerFound)" "adopt must run in the same shell"

  echo "== checkout mismatch (same build v1, other checkout) =="
  OUT="$(run_phase stale v1 THIRD "$WORK/other-checkout")"; echo "$OUT"
  assert_eq "$(field "$OUT" adopted)" "false" "a checkout mismatch must not adopt"
  P2="$(pid_of "$OUT")"
  [ "$P2" != "$P1" ] || fail "checkout mismatch must start a new host pid"
  assert_dead "$P1" "the old host must be replaced on a checkout mismatch"

  echo "== stale build (build v2) =="
  OUT="$(run_phase stale v2 FOURTH)"; echo "$OUT"
  assert_eq "$(field "$OUT" adopted)" "false" "a build mismatch must not adopt"
  P3="$(pid_of "$OUT")"
  [ "$P3" != "$P2" ] || fail "a build mismatch must start a new host pid"
  assert_dead "$P2" "the old host must be replaced on a build mismatch"

  echo "== cleanup ($label) =="
  run_phase cleanup v2 >/dev/null
  assert_dead "$P3" "the host must be gone after shutdown"
  rm -rf "$WORK"
  WORK=""
  SOCKET=""
done

echo "all $ASSERTIONS assertions passed"
