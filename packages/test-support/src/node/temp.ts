/** The temp base and directory naming shared by every test — the root harness and the package
 * tests — so one run's leftover is attributable to it wherever it is written.
 *
 * A run's tree puts the terminal host's unix socket at
 * `<base>/corvi-<token>-<label>-XXXXXX/state/corvi/host.sock`. macOS caps a socket path at 104
 * bytes; its per-user `$TMPDIR` walks the wrapper's root over that budget, so the base is `/tmp`
 * there and `tmpdir()` elsewhere (already short).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const testTempBaseFor = (platform: NodeJS.Platform, temp: string): string =>
  platform === "darwin" ? "/tmp" : temp;

export const testTempBase = (): string => testTempBaseFor(process.platform, tmpdir());

/** The token a run's paths carry. The suite writes `CORVI_TEST_RUN`; a lone package test mints
 * one the cleaner can still read. */
export const runToken = (): string =>
  process.env.CORVI_TEST_RUN ?? `${Date.now().toString(36)}.${process.pid.toString(36)}`;

/** A token-named temp directory under the base. */
export const testTempDir = (label: string): Promise<string> =>
  mkdtemp(join(testTempBase(), `corvi-${runToken()}-${label}-`));
