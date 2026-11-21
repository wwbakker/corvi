import { type JSX, useCallback, useEffect, useState } from "react";
import { apiClient } from "../../app-root/api.ts";
import type { LeaveGuard } from "../../app-root/navigation.ts";
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  DEFAULT_WORKSPACE,
  type ResolvedDto as Config,
  type WorkspaceDto,
} from "@corvi/contracts/config";
// The settings vocabulary lives in the module's model.ts, so the browser bundle gets none of
// the server's file handling with it.
import type { Settings, SettingsView } from "../model.ts";
import { ExtensionToggles } from "./SettingsFields.tsx";
import { RemoteAccessSection } from "./RemoteAccessSection.tsx";
import { DevicesSection } from "./DevicesSection.tsx";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { ContextsSection } from "./ContextsSection.tsx";
import { ExtensionSettingsSection } from "./ExtensionSettingsSection.tsx";
import {
  EnvironmentSection,
  IdeationSection,
  LocationsSection,
  NotificationsSection,
  WindowSection,
  WorktreesSection,
} from "./CoreSections.tsx";
import { SettingsTree, type SettingsTreeNode } from "./SettingsTree.tsx";
import type { Overrides, SettingsScope } from "./settingsScope.ts";

/**
 * Everything that lives in the config file, edited here rather than in an editor.
 *
 * The file stays the source of truth and stays hand-editable — this writes it, and the server
 * puts it into effect at once. Which is why the page is a thin thing: it knows the shape of the
 * settings and nothing about what they mean.
 *
 * The page has two axes: the sections as a tree on the left, and the scope (Global, or one
 * workspace) inside the detail view on the right. Both scopes hold the same settings — a
 * workspace overrides the global level key by key — so each section is drawn once, from one
 * shape. The scope is sticky: walking the tree never changes which scope you were reading, and
 * a section that cannot be edited in that scope says so rather than switching under you.
 *
 * Three conventions run through it. An empty field is "not set", and shows the value that applies
 * anyway as its placeholder, so the difference between a default and a decision stays visible:
 * inside a workspace that is the global value, draft edits included. A setting an environment
 * variable is overriding is locked, with the variable named: the variable wins at every scope, so
 * an editable box would be a lie. And a decision that is not this scope's own says so, with a way
 * back to inheriting — clearing a field, or "use Global's".
 *
 * A fourth is the write's own: the server merges what it is given over the file it already has,
 * so a top-level field left out of the request keeps whatever the file said. Clearing is
 * therefore always a *value* — an empty string, a `false` — and never "nothing", because JSON
 * drops a key whose value is `undefined` and the merge then keeps the old answer. (Inside
 * `workspaces` the whole list is replaced, so a workspace's `settings` may drop keys freely: that
 * is how "use Global's" works.)
 */

/** The draft as the page holds it: the file's contents, edited. */
type Draft = Settings;

/** The labels from a group down to a node, for the detail pane's breadcrumb. */
function trailTo(nodes: readonly SettingsTreeNode[], id: string): readonly string[] {
  for (const node of nodes) {
    if (node.id === id) return [node.label];
    const child = trailTo(node.children ?? [], id);
    if (child.length) return [node.label, ...child];
  }
  return [];
}

export function SettingsPage({
  onSaved,
  onGuard,
}: {
  onSaved: () => void;
  /** The shell's leave guard slot: filled while this page is mounted (app-root/navigation.ts). */
  onGuard: (guard: LeaveGuard | null) => void;
}): JSX.Element {
  const [view, setView] = useState<SettingsView>();
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // Which scope and which section are on screen. A view, not part of the draft: saving does not
  // change them. `selectedScope` is a workspace's index into the draft's list, or "global"; it
  // stays put while the tree is walked.
  const [selectedScope, setSelectedScope] = useState<"global" | number>("global");
  const [selected, setSelected] = useState("locations");

  useEffect(() => {
    apiClient.settings
      .read()
      .then((v) => {
        setView(v);
        setDraft(v.file);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // The leave guard: whether the draft differs from the file, and the one save that ends it.
  // Published for as long as this page is mounted; the shell reads it at navigation time.
  const dirty = view !== undefined && JSON.stringify(draft) !== JSON.stringify(view.file);

  /** Writes the draft and resolves to whether it was saved. A failure keeps the draft and lands
   * in the error banner below — whichever button started the save. */
  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    try {
      const v = await apiClient.settings.write(draft);
      setView(v);
      setDraft(v.file);
      setSaved(true);
      // The sidebar's contexts come from the same file: it should not still be showing a
      // workspace that has just been renamed away.
      onSaved();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, onSaved]);

  useEffect(() => {
    // The view it guards is the guard's configuration: the shell puts this URL back on a held
    // Back without knowing which page it is protecting. What is unsaved is this page's to name.
    onGuard({ view: { name: "settings" }, dirty, subject: "Unsaved settings", save });
    return () => onGuard(null);
  }, [dirty, save, onGuard]);

  if (!view) {
    return (
      <div className="page">
        <header>
          <h2>Settings</h2>
        </header>
        {error ? <div className="error-banner">{error}</div> : <p className="hint">loading…</p>}
      </div>
    );
  }

  const effective: Config = view.effective;
  const lock = (field: string): string | undefined => view.overridden[field];
  const set = (patch: Draft): void => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  };

  // The scope on screen. A workspace that is not configured yet — the default one, when no
  // workspace exists — reads as DEFAULT_WORKSPACE and materializes into the draft on first edit.
  const list: WorkspaceDto[] = draft.workspaces ?? [];
  // A workspace can disappear under the view — removed here, or by a hand edit to the file. An
  // index outside the list would quietly read as the Default workspace, so an out-of-range scope
  // is the global level. Index 0 is kept on an empty list: that is the synthetic Default
  // workspace the page offers before any is configured.
  const scope: "global" | number =
    typeof selectedScope === "number" && selectedScope >= Math.max(list.length, 1) ? "global" : selectedScope;
  const workspace = scope === "global" ? undefined : (list[scope] ?? DEFAULT_WORKSPACE);
  const own: Overrides = workspace?.settings ?? {};
  // A remote workspace's settings live on the server that hosts it: it has no settings fields
  // here, only its Context (where the target and token are edited).
  const remoteWorkspace = workspace?.remote !== undefined;

  const setWorkspaces = (index: number, next: WorkspaceDto): void => {
    const workspaces = [...list];
    workspaces[index] = next;
    set({ workspaces });
  };
  const setOwn = (patch: Overrides): void => {
    if (!workspace || scope === "global") return;
    setWorkspaces(scope, { ...workspace, settings: { ...own, ...patch } });
  };
  /** This scope's own value for a setting; `undefined` means "not set here". */
  const value = <K extends keyof Overrides>(key: K): Overrides[K] =>
    scope === "global" ? (draft[key] as Overrides[K]) : own[key];
  /** What applies when this scope sets nothing: the global value (draft edits included) over
   * the effective one — which is what the placeholder shows. */
  const inherited = <K extends keyof Overrides>(key: K): Overrides[K] =>
    scope === "global"
      ? ((effective as unknown as Overrides)[key] as Overrides[K])
      : ((draft[key] ?? (effective as unknown as Overrides)[key]) as Overrides[K]);
  const setSetting = <K extends keyof Overrides>(key: K, next: Overrides[K]): void => {
    if (scope === "global") set({ [key]: next } as Partial<Draft>);
    else setOwn({ [key]: next } as Overrides);
  };
  /** Drop this scope's decision and inherit the global one again — a workspace's alone. */
  const dropSetting = (key: keyof Overrides): void => {
    if (scope === "global" || !workspace) return;
    const settings = { ...own };
    delete settings[key];
    setWorkspaces(scope, { ...workspace, settings });
  };

  // The one view of the scope a section form gets: what it sets, what it inherits and the writes
  // that change it. The page resolves the chain; a form never does.
  const sectionScope: SettingsScope = {
    at: scope,
    value,
    inherited,
    set: setSetting,
    drop: dropSetting,
    lock,
  };

  // The extensions' settings live in the bag, under the extension's own name, at both scopes. A
  // value is one string or a list of them; the save prunes the empties — empty means unset.
  const bag = scope === "global" ? draft.extensionSettings : own.extensionSettings;
  const inheritedBag =
    scope === "global"
      ? effective.extensionSettings
      : (draft.extensionSettings ?? effective.extensionSettings);
  const bagValue = (name: string, key: string): string | string[] | undefined => bag?.[name]?.[key];
  const inheritedBagValue = (name: string, key: string): string | string[] | undefined =>
    inheritedBag?.[name]?.[key];
  const setBagValue = (name: string, key: string, next: string | string[]): void => {
    const patch = {
      extensionSettings: {
        ...bag,
        [name]: { ...(bag?.[name] ?? {}), [key]: next },
      },
    } as Overrides;
    if (scope === "global") set(patch as Partial<Draft>);
    else setOwn(patch);
  };
  const dropBagValue = (name: string, key: string): void => {
    if (scope === "global" || !workspace) return;
    const fields = { ...(bag?.[name] ?? {}) };
    delete fields[key];
    const extensionSettings = { ...bag, [name]: fields };
    if (!Object.keys(fields).length) delete extensionSettings[name];
    const settings = { ...own, extensionSettings };
    setWorkspaces(scope, { ...workspace, settings });
  };

  // The extensions with a page of their own, in the order they loaded. They sit in the tree at
  // every scope: whether one is enabled in a workspace decides what its page says, not whether
  // the page can be found.
  const extensionPages = view.extensions.filter((extension) => extension.settings.length);

  // The tree: every section, grouped the way the settings divide. The order is deliberate —
  // workspace first, then how the app looks and behaves, then what extends it, then the network.
  const treeNodes: SettingsTreeNode[] = [
    {
      id: "workspace",
      label: "Workspace",
      children: [
        { id: "contexts", label: "Contexts" },
        { id: "locations", label: "Locations" },
        { id: "worktrees", label: "Worktrees" },
        { id: "ideation", label: "Ideation" },
        { id: "environment", label: "Environment" },
      ],
    },
    {
      id: "behavior",
      label: "Appearance & Behavior",
      children: [
        { id: "appearance", label: "Appearance" },
        { id: "window", label: "Window" },
        { id: "notifications", label: "Notifications" },
      ],
    },
    {
      id: "extensions",
      label: "Extensions",
      children: extensionPages.map((extension) => ({
        id: `extension:${extension.name}`,
        label: extension.title,
      })),
    },
    {
      id: "remote",
      label: "Remote",
      children: [
        { id: "remoteAccess", label: "Remote access" },
        { id: "devices", label: "Devices" },
      ],
    },
  ];

  // An extension can be unloaded between saves; fall back to the first section rather than to an
  // empty pane. The scope is never touched by a fallback.
  const selectedTrail = trailTo(treeNodes, selected);
  const selectedId = selectedTrail.length ? selected : "locations";
  const trail = selectedTrail.length ? selectedTrail : trailTo(treeNodes, selectedId);
  const groupLevel = selectedId === "workspace" || selectedId === "behavior" || selectedId === "remote";
  // Machine-level sections: they belong to no workspace, so they have no scope tabs at all.
  const globalOnly = selectedId === "appearance" || selectedId === "remoteAccess" || selectedId === "devices";
  // The one workspace-only section.
  const contexts = selectedId === "contexts";
  // Everything else — the sections a workspace can override, and the extensions' own pages.
  const scoped = !groupLevel && !globalOnly && !contexts;
  const extensionName = selectedId.startsWith("extension:")
    ? selectedId.slice("extension:".length)
    : undefined;
  const selectedExtension = extensionPages.find((extension) => extension.name === extensionName);

  // The scope bar's entries: Global, then the workspaces, then — in Contexts — the one that
  // adds. Removing the last configured workspace leaves the draft empty and the Default
  // workspace takes its place — that one is not in the file, so its Context has no Remove.
  const workspaces = [
    ...list.map((one, index) => ({
      index,
      label: one.name || one.id || "Unnamed",
      removable: true,
    })),
    ...(list.length ? [] : [{ index: 0, label: DEFAULT_WORKSPACE.name, removable: false }]),
  ];
  const workspaceLabel = (index: number): string =>
    workspaces.find((one) => one.index === index)?.label ?? "this workspace";

  // The extensions a scope runs, concretely: its own selection, else the global draft's, else the
  // effective one (an environment variable or a default), else all of them. One chain, so the
  // scope tabs, the disabled note and the Extensions switches cannot disagree.
  const extensionsIn = (at: "global" | number): string[] => {
    const own = at === "global" ? undefined : list[at]?.settings?.extensions;
    return (
      own ?? draft.extensions ?? effective.extensions ?? view.extensions.map((extension) => extension.name)
    );
  };
  const extensionEnabledIn = (index: number, name: string): boolean => extensionsIn(index).includes(name);

  // What the detail pane says when the sticky scope cannot edit this section. Nothing here
  // changes the scope: the reader put it there, and only the reader moves it.
  const note = groupLevel
    ? "There are no settings at the group level — choose one of its sections in the tree."
    : contexts && scope === "global"
      ? "Contexts are workspace-specific — pick a workspace above, or add a context."
      : scoped && remoteWorkspace
        ? `The settings of ${workspaceLabel(scope as number)} live on the server that hosts it; edit them there.`
        : scoped &&
            selectedExtension &&
            typeof scope === "number" &&
            !extensionEnabledIn(scope, selectedExtension.name)
          ? `${selectedExtension.title} is disabled in ${workspaceLabel(
              scope,
            )}; enable it under Extensions to edit its settings here.`
          : undefined;

  // Which workspaces the extension page can show: the ones that run it. A workspace where it is
  // disabled has no settings to edit for it, so it is not offered as a scope.
  const scopeChoices = workspaces.filter(
    (one) => extensionName === undefined || extensionEnabledIn(one.index, extensionName),
  );

  const addContext = (): void => {
    set({ workspaces: [...list, { id: "", name: "" }] });
    setSelectedScope(list.length);
  };

  const toggleExtensions = (names: string[]): void => {
    const known = view.extensions.map((e) => e.name);
    const all = names.length === known.length;
    if (scope === "global") {
      // Back to everything: the key goes away, so the file stays a page of decisions.
      setSetting("extensions", all ? undefined : names);
      return;
    }
    // Inside a workspace the key goes away when the selection is the inherited one again.
    const inheritedList = inherited("extensions");
    const same =
      all === !inheritedList &&
      (all || [...names].sort().join() === [...(inheritedList ?? [])].sort().join());
    setSetting("extensions", same ? undefined : names);
  };

  return (
    <div className="page settings">
      <header>
        <h2>Settings</h2>
        <span className="spacer" />
        {saved && !dirty && <span className="hint saved">saved</span>}
        <button className="create" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>
      <p className="hint intro">
        Written to <code>{view.path}</code>, which stays hand-editable. Saving takes effect at once — no
        restart.
      </p>
      {error && <div className="error-banner">{error}</div>}

      {/* The two columns: the tree of sections, and the chosen one's fields. Each scrolls on its
          own, so a long form never takes the tree off screen. */}
      <div className="settings-body">
        <SettingsTree nodes={treeNodes} selected={selectedId} onSelect={setSelected} />

        <section className="settings-detail" aria-label="Settings detail">
          <h3 className="breadcrumb">{trail.join(" \u203a ")}</h3>

          {/* The scope belongs to the view, not to the navigation: switching sections leaves it
              where it was. A section that no scope can edit — a group, or a machine-level one —
              has no bar at all. */}
          {!groupLevel && !globalOnly && (
            <nav className="tabs scopes">
              {!contexts && (
                <button
                  className={scope === "global" ? "tab current" : "tab"}
                  onClick={() => setSelectedScope("global")}
                >
                  Global
                </button>
              )}
              {scopeChoices.map((one) => (
                <button
                  key={one.index}
                  className={scope === one.index ? "tab current" : "tab"}
                  onClick={() => setSelectedScope(one.index)}
                >
                  {one.label}
                </button>
              ))}
              {contexts && (
                <button className="add" onClick={addContext}>
                  + add a context
                </button>
              )}
            </nav>
          )}

          {note !== undefined ? (
            <p className="hint detail-note">{note}</p>
          ) : (
            <>
              {selectedId === "contexts" && workspace && (
                <ContextsSection
                  workspace={workspace}
                  onChange={(next) => setWorkspaces(scope as number, next)}
                  onRemove={
                    workspaces.find((one) => one.index === scope)?.removable
                      ? () => {
                          set({ workspaces: list.filter((_, index) => index !== scope) });
                          setSelectedScope("global");
                        }
                      : undefined
                  }
                />
              )}

              {selectedId === "locations" && (
                <LocationsSection scope={sectionScope} workspaceId={workspace?.id} />
              )}

              {selectedId === "worktrees" && (
                <WorktreesSection
                  scope={sectionScope}
                  toolingDefault={view.toolingDefault}
                  onRestoreDefaults={() => set({ worktreeCopy: view.toolingDefault })}
                />
              )}

              {selectedExtension && (
                <ExtensionSettingsSection
                  extension={selectedExtension}
                  scopeAt={scope}
                  access={{
                    value: (key) => bagValue(selectedExtension.name, key),
                    inherited: (key) => inheritedBagValue(selectedExtension.name, key),
                    set: (key, next) => setBagValue(selectedExtension.name, key, next),
                    drop: (key) => dropBagValue(selectedExtension.name, key),
                    locked: (key) => view.overriddenExtensions?.[selectedExtension.name]?.[key],
                  }}
                />
              )}

              {selectedId === "notifications" && <NotificationsSection scope={sectionScope} />}

              {selectedId === "window" && <WindowSection scope={sectionScope} />}

              {selectedId === "ideation" && <IdeationSection scope={sectionScope} />}

              {selectedId === "environment" && (
                <EnvironmentSection scope={sectionScope} inheritedEnv={draft.env ?? effective.env} />
              )}

              {selectedId === "devices" && <DevicesSection />}

              {selectedId === "remoteAccess" && (
                <RemoteAccessSection
                  enabled={draft.remoteAccess?.enabled ?? false}
                  port={draft.remoteAccess?.port ?? DEFAULT_REMOTE_ACCESS_PORT}
                  bindStatus={view.remoteAccessStatus}
                  onEnabledChange={(enabled) =>
                    set({
                      remoteAccess: { enabled, port: draft.remoteAccess?.port ?? DEFAULT_REMOTE_ACCESS_PORT },
                    })
                  }
                  onPortChange={(port) =>
                    set({ remoteAccess: { enabled: draft.remoteAccess?.enabled ?? false, port } })
                  }
                />
              )}

              {/* The theme is a per-device browser preference, not part of this file: it applies
                  as it is picked, outside the draft and the save below. */}
              {selectedId === "appearance" && <AppearanceSection />}

              {selectedId === "extensions" && (
                <div className="form">
                  <ExtensionToggles
                    known={view.extensions}
                    selected={extensionsIn(scope).filter((name) =>
                      view.extensions.some((extension) => extension.name === name),
                    )}
                    onInherit={
                      scope !== "global" && value("extensions") !== undefined
                        ? () => dropSetting("extensions")
                        : undefined
                    }
                    onChange={toggleExtensions}
                  />
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
