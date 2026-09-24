/**
 * Every `bun test` run works against its own tree — wrapper or lone file.
 *
 * The product resolves its writable locations as "an environment variable, else the user's real
 * one" (`CORVI_CONFIG` else `~/.config/corvi/config.json`, `CORVI_ROOT` else the configured
 * changes root, ...). That is right for the product and wrong for a test: a lone
 * `bun test test/foo.test.ts` — or an IDE's run button — would otherwise write the real config
 * and change directories. It once did.
 *
 * `bun run test`'s wrapper already sets all of these to a per-run root and cleans it up. This
 * preload is the same isolation — the same four names — for every other way of running tests: it
 * fills in only what the wrapper (or a deliberate test) left unset, into a temp root whose name
 * carries the run token, so `scripts/clean-test.ts` can attribute it — and `--prune` sweeps it if
 * a run dies before its exit handler. The wrapper's values always win;
 * `test/helpers.ts`'s `testRun()` picks up the token minted here and keeps writing the run's
 * pid-file.
 *
 * Wired in `bunfig.toml` (`[test] preload`), so it cannot be forgotten. `bun test` only: nothing
 * in a production or dev start-up loads this file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The names whose "else" case is a real directory in someone's home — exactly what the
 * `bun run test` wrapper exports, and nothing more: tests pin behaviour that depends on the
 * rest being unset (the tmux socket defaults to `-L corvi`, and a complete-flow test asserts
 * that exact command). Sockets and caches are the fixtures' job (`serverEnv`, `tmuxTempDir`),
 * as docs/guides/testing.md prescribes. */
const ISOLATED = [
  "CORVI_CONFIG",
  "CORVI_ROOT",
  "CORVI_ARCHIVE_ROOT",
  "XDG_STATE_HOME",
] as const;

const missing = ISOLATED.some((name) => process.env[name] === undefined);
if (missing) {
  // The run token in the name is what `scripts/clean-test.ts` reads as ownership; the format is
  // its own (`<base36>.<base36>`, what `date +%s.$$` produces) and `test/helpers.ts` validates
  // the same one. A token from the wrapper means this block did not run at all.
  process.env.CORVI_TEST_RUN ??= `${Date.now().toString(36)}.${process.pid.toString(36)}`;
  const token: string = process.env.CORVI_TEST_RUN;
  const root = mkdtempSync(join(tmpdir(), `corvi-${token}-iso-`));
  mkdirSync(join(root, "actions"), { recursive: true });

  const isolated = (name: string, value: string): void => {
    if (process.env[name] === undefined) process.env[name] = value;
  };
  isolated("CORVI_CONFIG", join(root, "config.json"));
  isolated("CORVI_ROOT", join(root, "changes"));
  isolated("CORVI_ARCHIVE_ROOT", join(root, "changes-archive"));
  isolated("XDG_STATE_HOME", join(root, "state"));
  // The empty config file a machine would not have: reads as "nothing configured", which is
  // where every test starts.
  writeFileSync(join(root, "config.json"), "{}");

  // A run that ends cleanly leaves nothing to sweep. One that dies keeps a token-named root for
  // `test:clean --prune`, exactly like the wrapper's own temp dirs.
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // a prune already took it
    }
  });
}
