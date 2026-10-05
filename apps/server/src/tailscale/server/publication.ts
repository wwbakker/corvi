/** The port Corvi published through `tailscale serve`, remembered across restarts.
 *
 * Runtime bookkeeping, not a setting: one small owner-only file under the state directory
 * (`@corvi/configuration/node`'s `stateDir`), written when a publish succeeds and removed when an
 * unpublish does. Without it, a restart that follows a configured-port change while published
 * cannot tell the 443 mapping is its own, and the user has to clean up by hand. Read once at
 * startup and installed into the runtime (`setTailscalePublishedPort`); nothing else is stored.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Schema } from "effect";

import { ID, stateDir } from "@corvi/configuration/node";

/** The one field: a real TCP port, so a hand-mangled file (or a value from a version that meant
 * something else) is no record rather than a wrong one. */
const Publication = Schema.Struct({
  port: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(65535),
    ),
  ),
});

/** Where the record lives: app state, beside the instance records and pid-files. */
export const publicationPath = (): string => join(stateDir(), `${ID}-tailscale.json`);

/** The port a previous run published, or undefined when there is no readable record. */
export const readPublishedPort = (): number | undefined => {
  try {
    const parsed = Schema.decodeUnknownSync(Publication)(
      JSON.parse(readFileSync(publicationPath(), "utf8")),
    );
    return parsed.port;
  } catch {
    return undefined;
  }
};

/** Remember the published port (`undefined` clears it). Atomic, so a reader never sees half a
 * file; owner-only, because it is this machine's own bookkeeping. Best effort: a state directory
 * that cannot be written must not fail a publish that already happened. Synchronous, because its
 * callers are the sync runtime setters on the publish/unpublish path. */
export const persistPublishedPort = (port: number | undefined): void => {
  try {
    if (port === undefined) {
      rmSync(publicationPath(), { force: true });
      return;
    }
    mkdirSync(dirname(publicationPath()), { recursive: true });
    const temp = `${publicationPath()}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ port }), { mode: 0o600 });
    renameSync(temp, publicationPath());
  } catch (error) {
    console.error("could not record the published Tailscale port:", error);
  }
};
