#!/usr/bin/env bash
#
# Phase 2 runner. Drives spike/status/run.ts, then asserts every check it reported and the
# leftover state. Isolated: its own temp dir, host socket, config, and no tmux at all.
set -euo pipefail
cd "$(dirname "$0")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/corvi-spike-status-XXXXXX")"
SOCKET="$WORK/host.sock"
CHECKOUT="$WORK/checkout"
mkdir -p "$CHECKOUT"
ASSERTIONS=0
HOST_PID=""

cleanup() {
  if [ -S "$SOCKET" ]; then
    node ../terminal-host/prove.ts --phase cleanup --socket "$SOCKET" --checkout "$CHECKOUT" --build-id phase2 >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup INT TERM EXIT

fail() { echo "ASSERT FAILED: $*" >&2; exit 1; }
assert_true() { ASSERTIONS=$((ASSERTIONS + 1)); [ "$1" = "true" ] || fail "$2 (got '$1')"; }
assert_gt() { ASSERTIONS=$((ASSERTIONS + 1)); awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>b)}' || fail "$3 (got '$1', want > $2)"; }

echo "== run.ts =="
node run.ts --socket "$SOCKET" --checkout "$CHECKOUT" > "$WORK/out.txt" 2>&1 || {
  cat "$WORK/out.txt" >&2
  fail "run.ts exited non-zero"
}
READY="$(sed -n 's/^READY //p' "$WORK/out.txt" | tail -1)"
[ -n "$READY" ] || { cat "$WORK/out.txt" >&2; fail "no READY line"; }
echo "$READY"

echo "== checks =="
for name in \
  host.adopted \
  identity.hostSeedsEnv \
  http.reporterInsidePtyUsesHostEnv \
  http.presentWorking \
  http.notifyExactlyOnce \
  http.twoSessionsIndependent \
  http.clearOnSessionEnd \
  http.deadSessionGone \
  http.plainShellIsTerminal \
  osc.present \
  osc.notifyExactlyOnce \
  osc.stripped \
  osc.clearedOnSessionEnd; do
  value="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).checks[process.argv[2]]))' "$READY" "$name")"
  assert_true "$value" "check $name"
done

for key in httpMs oscMs; do
  median="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).latencies[process.argv[2]].medianMs))' "$READY" "$key")"
  echo "latency $key median: $median ms"
  assert_gt "$median" 0 "latency $key"
done

echo "== leftovers =="
for f in "$SOCKET" "$SOCKET.token" "$SOCKET.pid" "$SOCKET.owner.json" "$SOCKET.lock"; do
  [ -e "$f" ] && fail "leftover $f"
done
if pgrep -af "terminal-host/host.ts" | grep -qF "$SOCKET"; then
  fail "a host process for $SOCKET is still running"
fi

echo "all $ASSERTIONS assertions passed"
