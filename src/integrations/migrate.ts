import { loaded } from "./loaded.ts";
import type { ConfigFile, Workspace } from "../domain/config.ts";

/**
 * Normalize the workspaces' extension settings against what is loaded, in place.
 *
 * Three retired shapes are folded into the ones the extensions read today:
 *
 * - a workspace still naming `ci` gets `github` and `azure-devops` in its place — the card the
 *   name belonged to is now two cards, and both halves of what it showed must stay visible;
 * - a workspace still naming `deployments` gets `azure-devops` — the page and its settings
 *   moved there unchanged;
 * - workspace `extensionSettings.deployments` moves to `extensionSettings.azure-devops`, and a
 *   legacy per-workspace `azure` object (`false`, or `{ organization, project }`) folds into
 *   the same bag (`false` additionally materializes an explicit extensions list without
 *   `azure-devops`, because naming some is the whole list);
 * - the legacy flat `azureOrganization`/`azureProject`/`azureDeploy` fields are left to the
 *   extension's own fallback read (azure-devops/legacy.ts) rather than copied: they stay
 *   readable where they are until that fallback is removed.
 *
 * A workspace with an explicit `extensions` list holding none of the retired names is never
 * touched. Everything else is left exactly as it was. Run after the built-ins load and after
 * every settings write, so both hand-edits and page writes land normalized.
 *
 * The loaded names are read from the registry, not passed in: this module sits beside it, and
 * the callers (the host, the settings write) already import from here.
 *
 * The whole file, not just the workspaces: the top-level `extensionSettings.deployments` bag
 * moves to `extensionSettings.azure-devops` alongside the per-workspace ones, so the settings
 * read hands the page one shape to edit and write back.
 */
export function migrateFileSettings(file: ConfigFile): ConfigFile {
  if (file.extensionSettings?.["deployments"] !== undefined) {
    const { ["deployments"]: legacy, ...rest } = file.extensionSettings;
    file.extensionSettings = {
      ...rest,
      "azure-devops": { ...legacy, ...file.extensionSettings["azure-devops"] },
    };
  }
  if (file.workspaces) migrateExtensionSettings(file.workspaces);
  return file;
}

export function migrateExtensionSettings(workspaces: Workspace[]): Workspace[] {
  const all = loaded.map((e) => e.name);
  for (const workspace of workspaces) {
    if (workspace.extensions) {
      const names = [...workspace.extensions];
      let changed = false;
      const swap = (old: string, replacements: string[]): void => {
        const at = names.indexOf(old);
        if (at === -1) return;
        names.splice(at, 1, ...replacements.filter((n) => !names.includes(n)));
        changed = true;
      };
      // The CI card is now two cards: both halves of what it showed stay visible.
      swap("ci", ["github", "azure-devops"]);
      swap("deployments", ["azure-devops"]);
      // A name nothing loaded answers for is the settings write's complaint, not the
      // migration's: unknown names ride through untouched.
      if (changed) workspace.extensions = names;
    } else if ((workspace as { azure?: unknown }).azure === false) {
      // The retired flag meant "this context has no pipelines": the list now says so.
      workspace.extensions = all.filter((name) => name !== "azure-devops");
    }
    migrateAzureBags(workspace);
  }
  return workspaces;
}

/** The `deployments` bags and the legacy per-workspace `azure` object fold into the
 * `azure-devops` bag the extension declares and reads. */
function migrateAzureBags(workspace: Workspace): void {
  const record = workspace as Workspace & { azure?: unknown };
  const bags = workspace.extensionSettings ?? {};
  const legacyBag = bags["deployments"];
  const ownBag = bags["azure-devops"];
  const legacy = record.azure;
  const site =
    legacy !== false && typeof legacy === "object" && legacy !== null
      ? (legacy as { organization?: unknown; project?: unknown })
      : undefined;
  const str = (field: unknown): string | undefined =>
    typeof field === "string" && field.trim() ? field : undefined;
  const folded: Record<string, string> = {
    ...legacyBag,
    ...ownBag,
    ...(str(site?.organization) && !ownBag?.["organization"] && !legacyBag?.["organization"]
      ? { organization: str(site?.organization)! }
      : {}),
    ...(str(site?.project) && !ownBag?.["project"] && !legacyBag?.["project"]
      ? { project: str(site?.project)! }
      : {}),
  };
  if (legacyBag !== undefined || site !== undefined || record.azure === false) {
    if (Object.keys(folded).length > 0) {
      workspace.extensionSettings = { ...bags, "azure-devops": folded };
    }
    const { ["deployments"]: _dropped, ...rest } = workspace.extensionSettings ?? {};
    workspace.extensionSettings = rest;
    if (Object.keys(workspace.extensionSettings).length === 0) {
      workspace.extensionSettings = undefined;
    }
    // The flag has done its work — the list says what it meant, the bag holds what it
    // configured — so it leaves the file rather than shadowing either.
    record.azure = undefined;
  }
}
