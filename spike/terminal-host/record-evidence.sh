#!/usr/bin/env bash
#
# Records the Phase 0 evidence in one place: runtime versions, the node-pty probe under each
# runtime and scenario, and the adoption/update proof. Everything uses this run's temp dirs and a
# private tmux/socket path; nothing touches a Corvi or tmux instance already running.
set -uo pipefail
cd "$(dirname "$0")/../.."   # the checkout root

ELECTRON="apps/desktop/node_modules/electron/dist/electron"

echo "===== versions ====="
echo "system node: $(node --version)"
echo "bun: $(bun --version)"
echo "electron: $(ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -e 'process.stdout.write(String(process.versions.electron))')"
echo "electron node: $(ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -e 'process.stdout.write(String(process.versions.node))')"
node -e 'const p=require("./apps/server/node_modules/node-pty/package.json"); process.stdout.write(`node-pty: ${p.version}\n`)'
node -e 'const fs=require("node:fs"); const d="./apps/server/node_modules/node-pty"; const pre=fs.existsSync(`${d}/prebuilds/${process.platform}-${process.arch}/pty.node`); const built=fs.existsSync(`${d}/build/Release/pty.node`); process.stdout.write(`platform: ${process.platform}-${process.arch}, prebuild: ${pre}, node-gyp build: ${built}\n`)'

echo
echo "===== probe: node ====="
node spike/terminal-host/probe.ts --label node --scenario exec
node spike/terminal-host/probe.ts --label node --scenario interactive
node spike/terminal-host/probe.ts --label node --scenario delayed

echo
echo "===== probe: electron (ELECTRON_RUN_AS_NODE=1) ====="
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" spike/terminal-host/probe.ts --label electron --scenario exec
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" spike/terminal-host/probe.ts --label electron --scenario interactive
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" spike/terminal-host/probe.ts --label electron --scenario delayed

echo
echo "===== probe: bun ====="
bun spike/terminal-host/probe.ts --label bun --scenario exec
bun spike/terminal-host/probe.ts --label bun --scenario interactive
bun spike/terminal-host/probe.ts --label bun --scenario delayed

echo
echo "===== adoption / update ====="
bash spike/terminal-host/run-adoption.sh
