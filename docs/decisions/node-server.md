# The server runs on Node

> **Kind:** decision · **Status:** accepted

## Context

The app's window became Electron ([`electron-host.md`](electron-host.md)), but the server behind
it was still `bun src/server.ts`, spawned through the login shell — so using the app required Bun
installed and on the shell's PATH, and the window carried a shell between it and the process it
managed. Electron already ships a Node, and the server's TypeScript runs under it directly (Node
24's type stripping; `src/` has no enums, namespaces or parameter properties), so the runtime
could change without a server build step at all.

## Decision

**The app starts the server on Electron's own Node.** `startServer`
(scripts/app/electron/main.ts) runs `ELECTRON_RUN_AS_NODE=1 <Electron> src/server.ts` through the
login shell — still needed for `JIRA_API_TOKEN` and the like — with the checkout as the working
directory and the server as the shell's whole command (`exec`), so the pid the window records is
the server's own and closing the window stops the server it started.

**HTTP stays.** The window, the page and the extension contract are untouched: the same routes,
the same SSE stream, the same ttyd WebSocket proxy. The transport was not the point; the runtime
is.

**The server is runtime-agnostic.** `Bun.serve` becomes `capabilities/serve.ts`, the same route
table shape over `node:http` + `ws`; `Bun.file`/`Bun.write` become `capabilities/files.ts` over
`node:fs/promises`; `Bun.spawn`, `Bun.which`, `Bun.nanoseconds`, `Bun.listen`/`Bun.connect` and
`import.meta.dir` become their Node equivalents. The page build — the genuinely Bun-shaped part,
`import index from "./index.html"` plus `Bun.build` — becomes esbuild (`src/app-root/client.ts`,
`src/extension-host/clientChunks.ts`), which runs on both. Bun remains the development and test
toolchain: `bun run dev`, `bun test` and the install scripts are unchanged, and the suite keeps
spawning `bun src/server.ts` — now exercising the same runtime-agnostic code the app runs.

**Verified on both.** `test/node-runtime.test.ts` boots the server under Electron's Node, lets it
build the page with esbuild in that process and answers an API call; the full suite runs the same
server under Bun; and `bun run app:drive` opens the app, which starts its server with no Bun on
PATH.

## Consequences

- Using an installed app no longer needs Bun on PATH; the login shell stays only for the
  environment a Dock or desktop launch does not inherit. The server still runs from the checkout,
  so `node_modules` must be installed there — which the server has always needed.
- `ws` and `esbuild` join the runtime dependencies; Electron's Node runs TypeScript directly, so
  there is no server build step.
- In development the page is rebuilt by esbuild when a source file changes (checked on request),
  not by Bun's HTML route: editing the page is a refresh, not a server restart, but there is no
  hot module replacement.
- The perf trace keeps its wall-time numbers; per-child CPU is not readable from Node, and that
  field stays at zero.
- Self-contained installs — server and client built into the app bundle — remain possible, not
  done: this decision is about the runtime, not packaging.
- Superseded in part by [`node-pty-terminal.md`](node-pty-terminal.md): the server runs on Node
  in development too, because the terminal's pty library delivers nothing under Bun.
