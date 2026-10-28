/**
 * The base a test run puts its temp trees under.
 *
 * A run's tree puts the terminal host's unix socket at
 * `<base>/corvi-<token>-<label>-XXXXXX/state/corvi/host.sock`. macOS caps a socket path at 104
 * bytes: a 104-byte path fills `sun_path` and binds (the kernel does not require a NUL when the
 * path is exactly that long), and 105 fails with `EINVAL`; the host then dies silently
 * (`stdio: ignore`) and every host test reports "the host did not come up". macOS's `$TMPDIR` is
 * a per-user `/var/folders/…` path that walks the wrapper's own root over that budget — its
 * socket was 105 bytes on the machine this was fixed on. `/tmp` is short and on the same
 * machine; elsewhere `tmpdir()` is already short, so it is used as written.
 *
 * Test infrastructure only: the product's own socket is not moved. Cleanup scans this base and
 * `tmpdir()` (`scripts/clean-test.ts`), so entries from either spelling are still found.
 */
import { tmpdir } from "node:os";

export const testTempBaseFor = (platform: NodeJS.Platform, temp: string): string =>
  platform === "darwin" ? "/tmp" : temp;

export const testTempBase = (): string => testTempBaseFor(process.platform, tmpdir());
