#!/usr/bin/env bash
#
# Phase 3 runner: builds the recorded stream if missing, runs the renderer-owned/server-owned
# measurement (`run.ts`) and the real-page smoke (`page-smoke.ts`), and asserts every check.
# Isolated: its own temp dir and host socket; no tmux; the host is shut down at the end.
set -euo pipefail
cd "$(dirname "$0")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/corvi-spike-screen-XXXXXX")"
SOCKET="$WORK/host.sock"
CHECKOUT="$WORK/checkout"
mkdir -p "$CHECKOUT"
ASSERTIONS=0

cleanup() {
  if [ -S "$SOCKET" ]; then
    node ../terminal-host/prove.ts --phase cleanup --socket "$SOCKET" --checkout "$CHECKOUT" --build-id phase3 >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  rm -f page.js page.html
}
trap cleanup INT TERM EXIT

fail() { echo "ASSERT FAILED: $*" >&2; exit 1; }
assert_true() { ASSERTIONS=$((ASSERTIONS + 1)); [ "$1" = "true" ] || fail "$2 (got '$1')"; }
assert_gt() { ASSERTIONS=$((ASSERTIONS + 1)); awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>b)}' || fail "$3 (got '$1', want > $2)"; }

if [ ! -f stream.bin ]; then
  echo "== recording stream.bin =="
  node record.ts
fi

echo "== measurement =="
node run.ts --socket "$SOCKET" --checkout "$CHECKOUT" > "$WORK/run.txt" 2>&1 || { cat "$WORK/run.txt" >&2; fail "run.ts exited non-zero"; }
READY="$(sed -n 's/^READY //p' "$WORK/run.txt" | tail -1)"
[ -n "$READY" ] || { cat "$WORK/run.txt" >&2; fail "no READY line"; }
echo "$READY"

for name in \
  renderer.cursor renderer.scroll renderer.rows renderer.serialized renderer.noDuplicateOrLoss \
  server.cursor server.scroll server.rows server.serialized \
  metrics.snapshot50kLarger metrics.reached50kRows \
  hardKill.losesBytesWithoutSnapshot \
  contract.hostStartedFresh contract.producedEnough contract.stable contract.truncatedWhenOld contract.resumeNotTruncated; do
  value="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).checks[process.argv[2]]))' "$READY" "$name")"
  assert_true "$value" "check $name"
done

for metric in rendererSnapshotBytes serverSnapshotBytes snapshotBytes_5k snapshotBytes_50k snapshotMs_5k snapshotMs_50k lostBytesWithoutSnapshot serverSnapshotOnConnectMs; do
  value="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).metrics?.[process.argv[2]] ?? JSON.parse(process.argv[1]).timings?.[process.argv[2]]))' "$READY" "$metric")"
  echo "metric $metric: $value"
  assert_gt "$value" 0 "metric $metric"
done

echo "== real page smoke =="
node page-smoke.ts > "$WORK/page.txt" 2>&1 || { cat "$WORK/page.txt" >&2; fail "page-smoke exited non-zero"; }
PAGE="$(sed -n 's/^READY //p' "$WORK/page.txt" | tail -1)"
[ -n "$PAGE" ] || { cat "$WORK/page.txt" >&2; fail "no page READY line"; }
echo "$PAGE"
for name in page.noErrors page.cursorMatches page.scrollMatches page.linesMatch page.serializedMatches; do
  value="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).checks[process.argv[2]]))' "$PAGE" "$name")"
  assert_true "$value" "check $name"
done

echo "== leftovers =="
for f in "$SOCKET" "$SOCKET.token" "$SOCKET.pid" "$SOCKET.owner.json" "$SOCKET.lock"; do
  [ -e "$f" ] && fail "leftover $f"
done
if pgrep -af "terminal-host/host.ts" | grep -qF "$SOCKET"; then
  fail "a host process for $SOCKET is still running"
fi

echo "all $ASSERTIONS assertions passed"
