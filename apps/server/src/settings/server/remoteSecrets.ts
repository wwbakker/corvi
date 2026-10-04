/** A remote workspace's device token is a secret in the config file, and the settings page is one
 * of the read surfaces for that file: this is where its value is replaced by the mask, and where
 * the write path keeps what is stored when the page cannot show it.
 *
 * It is deliberately separate from the extension-secret machinery (`./secrets.ts`): that reads
 * declarations to learn which extension bag fields are secret, while a remote token is a fixed
 * field of the core's own workspace shape. The two rules are the same, though — the page never
 * receives the token, and a save that does not retype it never deletes it.
 */
import { MASK } from "./secrets.ts";

/** One workspace as these rules see it: an id, and the two objects a secret could sit in. */
type RemoteWorkspaceEntry = {
  readonly id: string;
  readonly settings?: object;
  readonly remote?: { readonly token?: string };
};

/** The part of a config that carries workspaces. `Config` (what is in effect) and `ConfigFile`
 * (what is written) have the same shape here, which is why this is generic over it. */
type WithRemoteWorkspaces = { workspaces?: readonly RemoteWorkspaceEntry[] };

/** A copy of one workspace with its token masked. Every workspace is copied — not only the
 * token-bearing ones — and so are the objects that could nest a secret, so a consumer that
 * mutates the view can never reach the config a request is reading. */
const redact = <W extends RemoteWorkspaceEntry>(workspace: W): W =>
  ({
    ...workspace,
    ...(workspace?.settings === undefined ? {} : { settings: { ...workspace.settings } }),
    ...(workspace?.remote === undefined
      ? {}
      : {
          remote: {
            ...workspace.remote,
            ...(workspace.remote.token === undefined ? {} : { token: MASK }),
          },
        }),
  }) as W;

/** The config as the page may see it: every stored remote token replaced by the mask. A workspace
 * with no token is copied too; only its value is left alone. */
export const redactRemoteTokens = <T extends WithRemoteWorkspaces>(value: T): T => ({
  ...value,
  ...(value.workspaces === undefined ? {} : { workspaces: value.workspaces.map(redact) }),
});

/** The config as it must be written, from the form's point of view:
 *
 * - a `remote` sent **without** a token keeps the token stored for that workspace id — the editor
 *   cannot display it, so omission is "leave it alone", not "delete it";
 * - `token: ""` clears it (the field is removed, since the writer's `prune` does not descend into
 *   the `workspaces` array);
 * - the mask keeps what is stored, and a mask for a token nothing holds is dropped rather than
 *   becoming the token;
 * - a real token replaces it.
 *
 * `remote` omitted entirely converts the workspace to local: a remote target is a decision the
 * page makes, and not sending one is the page saying it is not remote.
 */
export const keepStoredRemoteTokens = <T extends WithRemoteWorkspaces>(
  next: T,
  stored: WithRemoteWorkspaces,
): T => ({
  ...next,
  ...(next.workspaces === undefined
    ? {}
    : {
        workspaces: next.workspaces.map((workspace) => {
          const remote = workspace?.remote;
          if (remote === undefined) return workspace;
          const before = stored.workspaces?.find((candidate) => candidate?.id === workspace.id)
            ?.remote?.token;
          // What the page's answer means: an omitted token keeps what is stored (the form cannot
          // show it), the mask keeps it too, and anything else is the page's own value. An empty
          // value, or a mask with nothing behind it, removes the field.
          const value = remote.token === undefined || remote.token === MASK ? before : remote.token;
          if (value === undefined || value === "") {
            const { token: _dropped, ...withoutToken } = remote;
            return { ...workspace, remote: withoutToken };
          }
          return { ...workspace, remote: { ...remote, token: value } };
        }),
      }),
});
