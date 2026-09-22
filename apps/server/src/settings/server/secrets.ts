/**
 * The secrets a config may hold, and the two rules that keep them out of the page.
 *
 * An extension declares a setting `secret` (apps/server/src/domain/settings.ts) and then owes the page
 * nothing: the settings view replaces every stored value with a mask before it is returned, and
 * the write path puts the stored value back wherever the mask comes back unchanged. A view that
 * never carried the token cannot leak it, and a save that does not retype it cannot delete it.
 *
 * Three things are deliberately not this file's business: which field is a secret (the
 * declarations say), where it is read (each integration reads its own bag), and what a mask means
 * beyond round-tripping. What is here is the two transformations, pure, so a test can drive them
 * directly.
 */

import type { ExtensionSetting, WorkspaceSetting } from "@corvi/contracts/integration";

/** What a stored secret is replaced by, in the view the page receives. The mask is opaque to the
 * browser — it round-trips whatever it was given — so nothing on the page has to know it. */
export const MASK = "********";

/** The declarations this file reads: the shape `ExtensionSetting` and `WorkspaceSetting` share,
 * so a test can state an extension without building one. */
export type SecretDeclarations = readonly {
  name: string;
  workspaceSettings?: readonly WorkspaceSetting[];
  globalSettings?: readonly ExtensionSetting[];
}[];

/** Which bag holds a secret: the config root's, or a workspace's. */
type Level = "global" | "workspace";

type Secret = { extension: string; key: string; level: Level };

const secretsOf = (declarations: SecretDeclarations): Secret[] => [
  ...declarations.flatMap((extension) =>
    (extension.globalSettings ?? [])
      .filter((field) => field.secret)
      .map((field) => ({ extension: extension.name, key: field.key, level: "global" as Level })),
  ),
  ...declarations.flatMap((extension) =>
    (extension.workspaceSettings ?? [])
      .filter((field) => field.secret)
      .map((field) => ({ extension: extension.name, key: field.key, level: "workspace" as Level })),
  ),
];

/** One extension's bag: what `extensionSettings[name]` holds. A workspace's bag holds strings
 * where the root's also holds lists, so both are this shape read as a wider one. */
type Bag = Record<string, Record<string, string | string[]>>;

/** The part of a config a secret lives in. `Config` (what is in effect) and `ConfigFile` (what is
 * written) are different types with the same shape here, which is why this is generic over it. */
type Bags = {
  extensionSettings?: Bag;
  workspaces?: readonly { id: string; extensionSettings?: Record<string, Record<string, string>> }[];
};

const read = (bag: Bag | undefined, secret: Secret): string | string[] | undefined =>
  bag?.[secret.extension]?.[secret.key];

/** Write one field, or remove it when there is nothing to write. Removing rather than leaving an
 * `undefined` keeps the object the shape the writer's `prune` already knows how to drop. */
const write = (bag: Bag | undefined, secret: Secret, value: string | string[] | undefined): void => {
  const fields = bag?.[secret.extension];
  if (!fields) return;
  if (value === undefined) delete fields[secret.key];
  else fields[secret.key] = value;
};

/** A copy deep enough that rewriting a secret cannot reach the original: the root, its bag, each
 * bag's extension objects, and the same for every workspace. Everything else is shared — it does
 * not change, and `effective` is the live config object a request in flight is reading. */
const copyBag = <B extends Bag>(bag: B): B =>
  Object.fromEntries(Object.entries(bag).map(([name, fields]) => [name, { ...fields }])) as B;

function copyBags<T extends Bags>(value: T): T {
  const workspaces = value.workspaces?.map((workspace) =>
    workspace.extensionSettings
      ? { ...workspace, extensionSettings: copyBag(workspace.extensionSettings) }
      : workspace,
  );
  return {
    ...value,
    ...(value.extensionSettings ? { extensionSettings: copyBag(value.extensionSettings) } : {}),
    ...(workspaces ? { workspaces } : {}),
  } as T;
}

/** The config as the page may see it: every stored secret replaced by the mask. A field nothing
 * was stored in stays absent — a mask for a token that does not exist is a question the save then
 * has to guess the answer to. */
export function redactSecrets<T extends Bags>(value: T, declarations: SecretDeclarations): T {
  const next = copyBags(value);
  for (const secret of secretsOf(declarations)) {
    const bags =
      secret.level === "global"
        ? [next.extensionSettings]
        : (next.workspaces ?? []).map((workspace) => workspace.extensionSettings);
    for (const bag of bags) {
      if (read(bag, secret) !== undefined) write(bag, secret, MASK);
    }
  }
  return next;
}

/** The config as it must be written: wherever the page sent a mask back, what is stored stands.
 * A mask for a field that holds nothing is not stored either — that is a save from a page that
 * was open before the secret existed, and writing the mask would make the mask the secret. */
export function keepStoredSecrets<T extends Bags>(
  next: T,
  stored: Bags,
  declarations: SecretDeclarations,
): T {
  const kept = copyBags(next);
  for (const secret of secretsOf(declarations)) {
    if (secret.level === "global") {
      keep(kept.extensionSettings, stored.extensionSettings, secret);
      continue;
    }
    for (const workspace of kept.workspaces ?? []) {
      const before = (stored.workspaces ?? []).find((candidate) => candidate.id === workspace.id);
      keep(workspace.extensionSettings, before?.extensionSettings, secret);
    }
  }
  return kept;
}

const keep = (bag: Bag | undefined, stored: Bag | undefined, secret: Secret): void => {
  // Anything but the mask is the page's own answer: a value it typed, or the empty string that
  // clears one. Only the mask is a question rather than an answer.
  if (read(bag, secret) !== MASK) return;
  write(bag, secret, read(stored, secret));
};
