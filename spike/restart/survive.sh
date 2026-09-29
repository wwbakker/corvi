#!/usr/bin/env bash
#
# Phase 1: the pty and its shells survive the server. A minimal server stand-in owns the
# registry (session id -> change/window) that the host deliberately does not. Each phase is a
# separate process so "SIGKILL the server" is real; the only thing left holding the shells is
# the host.
#
# Assertions:
#   1. A starts a host, opens s1/s2, marks them, writes the registry, then is SIGKILLed.
#   2. The host pid and both shells are still alive.
#   3. B adopts, re-associates through the registry, and new markers run in the same shells.
#   4. kill+reopen: a killed shell is non-clean (signal set), the reopen is a new incarnation,
#      and no stale data/exit for the old incarnation arrives after the reopen.
#   5. truncate: attaching with an old `since` reports truncated:true and an oldestSeq > 0.
#   6. `exit` typed into a detached session is clean (code 0, no signal); a later attach replays
#      the snapshot and delivers the final exit.
#   7. The host does not exit while a session is alive; it does after the idle period once none
#      is. No host/temp/lock/orphan shell is left behind.
#   8/9. SIGKILLing a host kills a normal shell and starts a fresh host on recovery; a child that
#      ignores SIGHUP survives (and is reaped by us), which is the honest limit of "orphan
#      cleanup".
set -euo pipefail
cd "$(dirname "$0")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/corvi-spike-restart-XXXXXX")"
SOCKET="$WORK/host.sock"
STATE="$WORK/registry.json"
CHECKOUT="$WORK/checkout"
CWD1="$WORK/changes/C1"
CWD2="$WORK/changes/C2"
CWD3="$WORK/changes/C3"
CWD4="$WORK/changes/C4"
mkdir -p "$CWD1" "$CWD2" "$CWD3" "$CWD4" "$CHECKOUT"
IDLE=800
ASSERTIONS=0
A_PID=""
C_PID=""
H_PID=""
SHELLS=()

cleanup() {
  [ -n "$A_PID" ] && kill -9 "$A_PID" 2>/dev/null || true
  [ -n "$C_PID" ] && kill -9 "$C_PID" 2>/dev/null || true
  [ -n "$H_PID" ] && kill -9 "$H_PID" 2>/dev/null || true
  for pid in "${SHELLS[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
  if [ -S "$SOCKET" ]; then
    node server.ts --phase c-recover --socket "$SOCKET" --checkout "$CHECKOUT" --build-id v1 >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup INT TERM EXIT

fail() { echo "ASSERT FAILED: $*" >&2; exit 1; }
assert_eq() { ASSERTIONS=$((ASSERTIONS + 1)); [ "$1" = "$2" ] || fail "$3 (got '$1', want '$2')"; }
assert_gt() { ASSERTIONS=$((ASSERTIONS + 1)); [ "$1" -gt "$2" ] 2>/dev/null || fail "$3 (got '$1', want > $2)"; }
assert_true() { ASSERTIONS=$((ASSERTIONS + 1)); [ "$1" = "true" ] || fail "$2 (got '$1')"; }
assert_alive() { ASSERTIONS=$((ASSERTIONS + 1)); kill -0 "$1" 2>/dev/null || fail "$2 (pid $1 is not alive)"; }
assert_dead() {
  ASSERTIONS=$((ASSERTIONS + 1))
  for _ in $(seq 1 240); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.025; done
  fail "$2 (pid $1 is still alive)"
}
assert_contains() { ASSERTIONS=$((ASSERTIONS + 1)); case "$1" in *"$2"*) ;; *) fail "$3 ('$1' does not contain '$2')" ;; esac; }

json_field() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]]))' "$1" "$2"; }
result_field() { node -e 'const r=JSON.parse(process.argv[1]).results.find(x=>x.id===process.argv[2]); process.stdout.write(String(r[process.argv[3]]))' "$1" "$2" "$3"; }
session_pid() { node -e 'const s=JSON.parse(process.argv[1]).sessions.find(x=>x.id===process.argv[2]); process.stdout.write(s?String(s.pid):"")' "$1" "$2"; }
alive_count() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).sessions.filter(s=>s.alive).length))' "$1"; }

wait_ready() {
  for _ in $(seq 1 400); do
    grep -q '^READY ' "$1" 2>/dev/null && return 0
    sleep 0.05
  done
  echo "no READY line in $1:" >&2
  cat "$1" >&2
  return 1
}
ready_json() { sed -n 's/^READY //p' "$1" | tail -1; }

base=(node server.ts --socket "$SOCKET" --checkout "$CHECKOUT" --build-id v1 --idle-ms "$IDLE")

echo "== 1. server A starts the host, opens s1/s2, is SIGKILLed =="
node server.ts --phase a --socket "$SOCKET" --state "$STATE" --checkout "$CHECKOUT" --build-id v1 \
  --idle-ms "$IDLE" --cwd1 "$CWD1" --cwd2 "$CWD2" > "$WORK/a.out" 2>&1 &
A_PID=$!
wait_ready "$WORK/a.out"
A="$(ready_json "$WORK/a.out")"; echo "A: $A"
assert_eq "$(json_field "$A" adopted)" "false" "A must start a fresh host"
assert_true "$(json_field "$A" s1)" "A must mark s1"
assert_true "$(json_field "$A" s2)" "A must mark s2"
HOST="$(json_field "$A" hostPid)"
kill -9 "$A_PID"; wait "$A_PID" 2>/dev/null || true; A_PID=""

echo "== 2. host and both shells survive server A =="
assert_alive "$HOST" "the host must outlive server A"
"${base[@]}" --phase inspect > "$WORK/inspect.out" 2>&1
INS="$(ready_json "$WORK/inspect.out")"; echo "inspect: $INS"
assert_true "$(json_field "$INS" adopted)" "inspect must adopt the surviving host"
assert_eq "$(json_field "$INS" hostPid)" "$HOST" "inspect must reach the same host pid"
assert_eq "$(alive_count "$INS")" "2" "both sessions must still be alive"
S1PID="$(session_pid "$INS" s1)"
S2PID="$(session_pid "$INS" s2)"
SHELLS+=("$S1PID" "$S2PID")
assert_alive "$S1PID" "shell s1 must survive"
assert_alive "$S2PID" "shell s2 must survive"

echo "== 7a. idle does not kill a host with a live session =="
sleep 2
assert_alive "$HOST" "the host must stay up while a session is alive"
assert_alive "$S1PID" "s1 must stay up through the idle window"

echo "== 3. server B adopts, re-associates the registry, runs in the same shells =="
node server.ts --phase b --socket "$SOCKET" --state "$STATE" --checkout "$CHECKOUT" --build-id v1 --idle-ms "$IDLE" \
  > "$WORK/b.out" 2>&1
B="$(ready_json "$WORK/b.out")"; echo "B: $B"
assert_true "$(json_field "$B" adopted)" "B must adopt the surviving host"
assert_eq "$(json_field "$B" hostPid)" "$HOST" "B must reach the same host pid"
for ID in s1 s2; do
  assert_true "$(result_field "$B" "$ID" alive)" "B must see $ID alive"
  assert_true "$(result_field "$B" "$ID" earlier)" "B must replay $ID's earlier marker"
  assert_true "$(result_field "$B" "$ID" newOk)" "B must run a new marker in $ID's same shell"
done

echo "== 4. kill+reopen: non-clean kill, new incarnation, no stale events =="
node server.ts --phase kill-reopen --socket "$SOCKET" --checkout "$CHECKOUT" --build-id v1 --idle-ms "$IDLE" --cwd "$CWD4" \
  > "$WORK/kr.out" 2>&1
KR="$(ready_json "$WORK/kr.out")"; echo "kill-reopen: $KR"
assert_true "$(json_field "$KR" marked)" "the first incarnation must run its marker"
assert_true "$(json_field "$KR" marked2)" "the second incarnation must run its marker"
assert_gt "$(json_field "$KR" oldExitSignal)" 0 "session.kill must produce a non-clean exit (signal set)"
assert_gt "$(json_field "$KR" newInc)" "$(json_field "$KR" oldInc)" "a reopen must get a new incarnation"
assert_eq "$(json_field "$KR" staleAfterReopen)" "0" "no stale old-incarnation event may arrive after reopen"
assert_true "$(json_field "$KR" newData)" "the new incarnation must deliver data"
SHELLS+=("$(json_field "$KR" oldPid)" "$(json_field "$KR" newPid)")

echo "== 5. truncation: attach before the buffer start reports truncated =="
node server.ts --phase truncate --socket "$SOCKET" --checkout "$CHECKOUT" --build-id v1 --idle-ms "$IDLE" --cwd "$CWD4" \
  > "$WORK/tr.out" 2>&1
TR="$(ready_json "$WORK/tr.out")"; echo "truncate: $TR"
assert_true "$(json_field "$TR" done)" "the flood must complete"
assert_true "$(json_field "$TR" truncated)" "attach with an old since must report truncated"
assert_gt "$(json_field "$TR" oldestSeq)" 0 "oldestSeq must have advanced past 0"
SHELLS+=("$(json_field "$TR" shellPid)")

echo "== 6. exit typed while detached is a defined, clean final state =="
"${base[@]}" --phase exit-detached > "$WORK/exit.out" 2>&1
E="$(ready_json "$WORK/exit.out")"; echo "exit-detached: $E"
assert_true "$(json_field "$E" s2Dead)" "s2 must exit while detached"
assert_eq "$(json_field "$E" attachAlive)" "false" "attach to dead s2 must report not alive"
assert_eq "$(json_field "$E" attachExitCode)" "0" "a typed exit must have exit code 0"
assert_eq "$(json_field "$E" attachSignal)" "0" "a typed exit must carry no signal"
assert_eq "$(json_field "$E" exitEvent)" "0" "attach to dead s2 must deliver the exit event"
assert_eq "$(json_field "$E" exitSignal)" "0" "the delivered typed-exit event must carry no signal"
assert_true "$(json_field "$E" replayed)" "attach to dead s2 must replay the snapshot"
REMAIN="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).remaining.join(","))' "$E")"
assert_contains "$REMAIN" "s2:dead" "the dead s2 record must be retained"
assert_contains "$REMAIN" "s1:dead" "a killed session must be retained as dead"

echo "== 7b. idle shutdown with no live sessions =="
assert_dead "$HOST" "the host must exit after the idle period with no live sessions"

echo "== 8. host SIGKILL kills a normal shell; a fresh server starts a fresh host =="
node server.ts --phase c-start --socket "$SOCKET" --checkout "$CHECKOUT" --build-id v1 --idle-ms "$IDLE" --cwd3 "$CWD3" \
  > "$WORK/c.out" 2>&1 &
C_PID=$!
wait_ready "$WORK/c.out"
C="$(ready_json "$WORK/c.out")"; echo "C: $C"
assert_true "$(json_field "$C" marker)" "C must mark s3"
CHOST="$(json_field "$C" hostPid)"
CSHELL="$(json_field "$C" shellPid)"
SHELLS+=("$CSHELL")
assert_alive "$CSHELL" "s3 shell must be alive"
kill -9 "$CHOST"
assert_dead "$CSHELL" "a normal shell must die with the host"
kill -9 "$C_PID" 2>/dev/null || true; wait "$C_PID" 2>/dev/null || true; C_PID=""

"${base[@]}" --phase c-recover > "$WORK/recover.out" 2>&1
R="$(ready_json "$WORK/recover.out")"; echo "c-recover: $R"
assert_eq "$(json_field "$R" adopted)" "false" "recovery must start a fresh host, not adopt dead records"
RHOST="$(json_field "$R" hostPid)"
[ "$RHOST" != "$CHOST" ] || fail "recovery must use a new host pid"
assert_eq "$(json_field "$R" sessionCount)" "0" "the fresh host must have no sessions"
assert_dead "$RHOST" "recovery must leave no host behind"

echo "== 9. a HUP-ignoring child survives the host's death (the honest limit) =="
node server.ts --phase hup-start --socket "$SOCKET" --checkout "$CHECKOUT" --build-id v1 --idle-ms "$IDLE" --cwd "$CWD4" \
  > "$WORK/hup.out" 2>&1 &
H_PID=$!
wait_ready "$WORK/hup.out"
HUP="$(ready_json "$WORK/hup.out")"; echo "hup-start: $HUP"
HHOST="$(json_field "$HUP" hostPid)"
HSHELL="$(json_field "$HUP" shellPid)"
SHELLS+=("$HSHELL")
assert_alive "$HSHELL" "the HUP-ignoring child must be alive before the host dies"
kill -9 "$HHOST"
assert_dead "$HHOST" "the host must be dead"
assert_alive "$HSHELL" "a HUP-ignoring child survives the host's SIGKILL (cannot be reaped by the host)"
kill -9 "$HSHELL"
assert_dead "$HSHELL" "we reap the HUP-ignoring child ourselves"
kill -9 "$H_PID" 2>/dev/null || true; wait "$H_PID" 2>/dev/null || true; H_PID=""

# The SIGKILLed HUP host left its socket/records (that is what SIGKILL does); recovery removes
# them and leaves no host behind.
"${base[@]}" --phase c-recover > "$WORK/recover2.out" 2>&1
R2="$(ready_json "$WORK/recover2.out")"; echo "post-hup recovery: $R2"
assert_eq "$(json_field "$R2" adopted)" "false" "post-hup recovery must not adopt the dead host's records"
assert_eq "$(json_field "$R2" sessionCount)" "0" "post-hup recovery must start with no sessions"

echo "== 10. nothing left behind (records, host, orphan shells) =="
for f in "$SOCKET" "$SOCKET.token" "$SOCKET.pid" "$SOCKET.owner.json" "$SOCKET.lock"; do
  [ -e "$f" ] && fail "leftover $f"
done
if pgrep -af "terminal-host/host.ts" | grep -qF "$SOCKET"; then
  fail "a host process for $SOCKET is still running"
fi
for pid in "${SHELLS[@]}"; do
  [ -n "$pid" ] && assert_dead "$pid" "orphaned shell $pid must be gone"
done

echo "all $ASSERTIONS assertions passed"
