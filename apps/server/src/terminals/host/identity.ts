/**
 * What a running terminal host is, and how it differs from the one this server would have started.
 *
 * Checkout and build are provenance; `protocol` is the compatibility contract. A host whose
 * protocol matches serves this server whatever it was started from, so a difference here is
 * something to report for the user to act on, never a reason to replace the host by itself.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL, type Owner } from "./protocol.ts";

/** The three facts that say which host this is. */
export type HostIdentity = {
  readonly checkout: string;
  readonly buildId: string;
  readonly protocol: number;
};

/** One way a running host is not the host this server would have started. `theirs` is the running
 * host's value and `ours` the one this server asked for. */
export type HostMismatch =
  | { readonly kind: "checkout"; readonly theirs: string; readonly ours: string }
  | { readonly kind: "build"; readonly theirs: string; readonly ours: string }
  | { readonly kind: "protocol"; readonly theirs: number; readonly ours: number };

export const identityOf = (owner: Owner): HostIdentity => ({
  checkout: owner.checkout,
  buildId: owner.buildId,
  protocol: owner.protocol,
});

/** The reasons `theirs` is not what `ours` describes, in a stable order. */
export const mismatches = (ours: HostIdentity, theirs: HostIdentity): readonly HostMismatch[] => {
  const found: HostMismatch[] = [];
  if (theirs.checkout !== ours.checkout) {
    found.push({ kind: "checkout", theirs: theirs.checkout, ours: ours.checkout });
  }
  if (theirs.buildId !== ours.buildId) {
    found.push({ kind: "build", theirs: theirs.buildId, ours: ours.buildId });
  }
  if (theirs.protocol !== ours.protocol) {
    found.push({ kind: "protocol", theirs: theirs.protocol, ours: ours.protocol });
  }
  return found;
};

/** The modules the host process runs. `client.ts` sits beside them and is the server's, so it is
 * deliberately not part of the host's identity: a change on the server's side of the socket must
 * not ask for a host restart. */
const HOST_MODULES = ["main.ts", "host.ts", "protocol.ts"] as const;

/** The directory those modules are in. */
export const HOST_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * The identity of the host code at `directory`: a content hash of the modules it runs.
 *
 * A hash rather than a commit id, because the host runs from source: what matters is exactly the
 * code that would start, and a docs-only update must not ask for a host restart the way a host
 * change does. Twelve hex characters, which is what a person can compare in a dialog.
 */
export const hostBuildId = (directory: string): string => {
  const hash = createHash("sha256");
  for (const module of HOST_MODULES) {
    hash.update(module);
    hash.update(readFileSync(join(directory, module)));
  }
  return hash.digest("hex").slice(0, 12);
};
