#!/usr/bin/env bash
#
# The adoption proof, driven as separate processes:
#   open   -> a client starts the host, opens a shell, sees a marker, then exits
#   adopt  -> a *new* client attaches to the still-running host and the same shell
#   stale  -> a client with a different build id replaces the host, not silently adopts it
#
# Every host is under this script's own temp dir; the script ends by shutting the host down.
set -uo pipefail
cd "$(dirname "$0")"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/corvi-spike-host-XXXXXX")"
SOCKET="$ROOT/host.sock"
NODE="${NODE:-node}"
trap '"$NODE" prove.ts --phase cleanup --socket "$SOCKET" --build-id v2 >/dev/null 2>&1; rm -rf "$ROOT"' EXIT

run() { # phase build-id [marker]
  "$NODE" prove.ts --phase "$1" --socket "$SOCKET" --build-id "$2" --marker "${3:-NONE}"
}

echo "== open (build v1) =="
OPEN="$(run open v1 FIRST)"; echo "$OPEN"
OLD_PID="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).hostPid))" "$OPEN")"
kill -0 "$OLD_PID" && echo "host $OLD_PID alive after the client exited: yes"

echo "== adopt (build v1, new client) =="
ADOPT="$(run adopt v1 SECOND)"; echo "$ADOPT"
ADOPT_PID="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).hostPid))" "$ADOPT")"
ADOPTED="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).adopted))" "$ADOPT")"
[ "$ADOPT_PID" = "$OLD_PID" ] && [ "$ADOPTED" = "true" ] && echo "adopted the same host $OLD_PID: yes"

echo "== stale (build v2, simulates an update) =="
STALE="$(run stale v2 THIRD)"; echo "$STALE"
NEW_PID="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).hostPid))" "$STALE")"
STALE_ADOPTED="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).adopted))" "$STALE")"
if kill -0 "$OLD_PID" 2>/dev/null; then echo "old host $OLD_PID still alive: UNEXPECTED"; else echo "old host $OLD_PID dead: yes"; fi
[ "$NEW_PID" != "$OLD_PID" ] && [ "$STALE_ADOPTED" = "false" ] && echo "replaced with a new host $NEW_PID: yes"

echo "== cleanup =="
run cleanup v2
