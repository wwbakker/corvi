#!/usr/bin/env bash
# The workload scripts/perf.ts measures: a TUI-like animation, the shape pi's "Working"
# spinner makes — full-width status lines redrawn about twelve times a second. A terminal that
# repaints like this is what exposed the canvas renderer's cost on WebKitGTK.
size=$(stty size 2>/dev/null || echo "40 200")
lines=${size% *}
cols=${size#* }
i=0
while :; do
  i=$((i + 1))
  printf '\033[1;1H\033[7m%-*s\033[0m' "$cols" " working $i "
  printf '\033[%d;1H\033[7m%-*s\033[0m' "$lines" "$(printf '%-*s' "$cols" " status $i | an agent at work | tokens 12345 ") "
  sleep 0.08
done
