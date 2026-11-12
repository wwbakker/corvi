# The Electron version

Status: `electron` is pinned below a Chromium canvas-font regression, with the check that says
when the pin can go.

| Decision | Reason and boundary |
| --- | --- |
| `apps/desktop/package.json` pins `electron` to 45.2.2 — the release before the regression's backport — instead of the newest 45.x | [electron/electron#55616](https://github.com/electron/electron/issues/55616): 45.2.3 backported a Chromium font-parser change without its follow-up fix, so `ctx.font` now rejects a font string that begins with a space and silently keeps `10px sans-serif`. xterm's WebGL renderer builds its glyph-atlas font that way for every upright glyph ([xtermjs/xterm.js#6297](https://github.com/xtermjs/xterm.js/issues/6297)), so terminals drew all their text at 10px inside full-size cells: small, thin, unevenly spaced, while italics and the app's own text were untouched. 45.2.2 carries the same Chromium 156, so nothing else from the bump that brought it is given up. |
| The pin is lifted by the check, not by release notes | The regression is a parser detail no test here can see: every headless run takes the DOM renderer, which builds `${size}px ${family}` and is unaffected. `bun run electron:check` asks the binary itself — the atlas string, read back — and exits non-zero while the font is rejected. |
| Only `electron` is pinned; `@xterm/xterm` 6.0.0 and `@xterm/addon-webgl` 0.19.0 stay at their newest stable releases | They are what builds the string, and the canonical shorthand has no leading space, but that fix is upstream's to ship. Replacing the renderer would remove the WebGL path rather than repair it, and the DOM renderer it falls back to is slower on heavy output, which is what a terminal spends its day on. |
| The check is a script, not a test | The probe needs a renderer, so it needs a window, so it needs a display; CI's unit job has none, and a skipped test would hide the one thing worth knowing. `scripts/electron-font.ts` runs where a terminal can open. |

## Raising the pin

```sh
bun run electron:check                            # this checkout's binary: must be accepted
bun run electron:check /tmp/electron-46/Electron.app/Contents/MacOS/Electron  # or any candidate
```

The output names the versions and what the canvas came back with. Accepted reads
`→ 24px monospace`; while the regression is present it reads `→ 10px sans-serif` and the script
exits 1. To raise the pin: pick a version the check accepts, bump `apps/desktop/package.json`,
`bun install`, `bun run electron:install`, then `bun run app:install` and restart the app — the
bundle carries the Electron framework, so the new binary takes effect only after a reinstall —
and look at a terminal in the real window, which is the only place the failure is visible. Then
delete this record: it describes a pin that no longer exists.
