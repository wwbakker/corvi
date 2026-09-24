import { type JSX, useCallback, useEffect, useState } from "react";
import { apiClient } from "../../app-root/api.ts";
import type { LeaveGuard } from "../../app-root/navigation.ts";
import {
  DEFAULT_WORKSPACE,
  type ResolvedDto as Config,
  type WorkspaceDto,
} from "@corvi/contracts/config";
// The settings vocabulary lives in the module's model.ts, so the browser bundle gets none of
// the server's file handling with it.
import type { Settings, SettingsView } from "../model.ts";
import type { ExtensionSetting } from "@corvi/contracts/integration";
import {
  CheckField,
  DirectoryField,
  EnvEditor,
  ExtensionToggles,
  Field,
  ListEditor,
  MarkdownField,
  TextArea,
  type KnownExtension,
} from "./SettingsFields.tsx";

/**
 * Everything that lives in the config file, edited here rather than in an editor.
 *
 * The file stays the source of truth and stays hand-editable — this writes it, and the server
 * puts it into effect at once. Which is why the page is a thin thing: it knows the shape of the
 * settings and nothing about what they mean.
 *
 * The page has two axes: the scope (Global, or one workspace) across the top, and the settings
 * down the side as section tabs. Both scopes hold the same settings — a workspace overrides the
 * global level key by key — so the sections below are drawn once, from one shape.
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

/** A workspace's settings: the same shape as the top level, overriding it key by key. Writable,
 * so the draft's edits copy-and-drop keys freely. */
type Overrides = {
  -readonly [K in keyof NonNullable<WorkspaceDto["settings"]>]: NonNullable<
    WorkspaceDto["settings"]
  >[K];
};

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
  // change them. `scope` is a workspace's index into the draft's list, or "global".
  const [scope, setScope] = useState<"global" | number>("global");
  const [tab, setTab] = useState("locations");

  useEffect(() => {
    apiClient
      .settings()
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
      const v = await apiClient.writeSettings(draft);
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
    // Back without knowing which page it is protecting.
    onGuard({ view: { name: "settings" }, dirty, save });
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
  const workspace = scope === "global" ? undefined : (list[scope] ?? DEFAULT_WORKSPACE);
  const own: Overrides = workspace?.settings ?? {};

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

  // The extensions' settings live in the bag, under the extension's own name, at both scopes. A
  // value is one string or a list of them; the save prunes the empties — empty means unset.
  const bag = scope === "global" ? draft.extensionSettings : own.extensionSettings;
  const inheritedBag = scope === "global" ? effective.extensionSettings : draft.extensionSettings ?? effective.extensionSettings;
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
  const asString = (value: string | string[] | undefined): string | undefined =>
    typeof value === "string" ? value : undefined;
  const asList = (value: string | string[] | undefined): string[] =>
    Array.isArray(value) ? value : [];

  // Which extensions this scope has anything to edit for. Inside a workspace an extension that
  // is disabled there has no settings to show — the switches on the Extensions section say so.
  const enabledHere = (name: string): boolean => {
    const selected = value("extensions") ?? inherited("extensions");
    return selected ? selected.includes(name) : true;
  };
  const shown = view.extensions.filter(
    (extension) =>
      extension.settings.length && (scope === "global" || enabledHere(extension.name)),
  );

  // The settings, one section each: the fixed ones, the extensions' own in the order they
  // loaded. The tab carries the heading, so the content below omits it. Stable ids, so a save
  // that reloads the view leaves you where you were. A workspace scope adds Context first.
  const tabs = [
    ...(scope === "global" ? [] : [{ id: "context", label: "Context" }]),
    { id: "locations", label: "Locations" },
    { id: "worktrees", label: "Worktrees" },
    ...shown.map((extension) => ({ id: `extension:${extension.name}`, label: extension.title })),
    { id: "notifications", label: "Notifications" },
    { id: "window", label: "Window" },
    { id: "ideation", label: "Ideation" },
    { id: "environment", label: "Environment" },
    { id: "extensions", label: "Extensions" },
  ];
  // An extension can be unloaded between saves; fall back to the first tab rather than to an
  // empty page.
  const active = tabs.some((one) => one.id === tab) ? tab : tabs[0]!.id;

  // The scope bar: Global, then the workspaces, then the one that adds. Removing the last
  // configured workspace leaves the draft empty and the Default workspace takes its place —
  // that one is not in the file, so its Context has no Remove.
  const workspaces = [
    ...list.map((one, index) => ({
      index,
      label: one.name || one.id || "Unnamed",
      removable: true,
    })),
    ...(list.length
      ? []
      : [{ index: 0, label: DEFAULT_WORKSPACE.name, removable: false }]),
  ];

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
      <p className="hint">
        Written to <code>{view.path}</code>, which stays hand-editable. Saving takes effect at
        once — no restart.
      </p>
      {error && <div className="error-banner">{error}</div>}

      {/* The scopes: the global level and one per workspace, each holding the same settings
          below. A workspace overrides the global level key by key. */}
      <nav className="tabs scopes">
        <button
          className={scope === "global" ? "tab current" : "tab"}
          onClick={() => {
            setScope("global");
            setTab("locations");
          }}
        >
          Global
        </button>
        {workspaces.map((one) => (
          <button
            key={one.index}
            className={scope === one.index ? "tab current" : "tab"}
            onClick={() => {
              setScope(one.index);
              setTab("context");
            }}
          >
            {one.label}
          </button>
        ))}
        <button
          className="add"
          onClick={() => {
            set({ workspaces: [...list, { id: "", name: "" }] });
            setScope(list.length);
            setTab("context");
          }}
        >
          + add a context
        </button>
      </nav>

      {/* The sections as tabs rather than one long scroll, in the same tab bar the change pages
          use. Extensions with settings of their own get their own tab; the ones without have
          nothing to show and no tab. */}
      <nav className="tabs sections">
        {tabs.map((one) => (
          <button
            key={one.id}
            className={one.id === active ? "tab current" : "tab"}
            onClick={() => setTab(one.id)}
          >
            {one.label}
          </button>
        ))}
      </nav>

      {active === "context" && workspace && (
        <div className="form">
          <Field
            label="Name"
            hint="What this context is called: a client, or your own projects."
            placeholder="Client"
            value={workspace.name}
            onChange={(name) => setWorkspaces(scope as number, { ...workspace, name })}
          />
          <Field
            label="Id"
            hint="Recorded in every change made here, and never changed afterwards: renaming it orphans them."
            value={workspace.id}
            onChange={(id) => setWorkspaces(scope as number, { ...workspace, id })}
          />
          {workspaces.find((one) => one.index === scope)?.removable && (
            <button
              className="remove"
              onClick={() => {
                set({ workspaces: list.filter((_, i) => i !== scope) });
                setScope("global");
                setTab("locations");
              }}
            >
              Remove this context
            </button>
          )}
        </div>
      )}

      {active === "locations" && (
        <div className="form">
          <DirectoryField
            label="Changes root"
            hint="One directory per change: its worktrees and its change.json."
            value={value("changesRoot")}
            placeholder={inherited("changesRoot")}
            locked={lock("changesRoot")}
            workspace={workspace?.id}
            onChange={(changesRoot) => setSetting("changesRoot", changesRoot)}
          />
          <DirectoryField
            label="Archive root"
            hint="Where completed changes are moved, so the changes root holds the work in flight."
            value={value("archiveRoot")}
            placeholder={inherited("archiveRoot")}
            locked={lock("archiveRoot")}
            workspace={workspace?.id}
            onChange={(archiveRoot) => setSetting("archiveRoot", archiveRoot)}
          />
          <DirectoryField
            label="Repositories directory"
            hint="Where the repository browser opens. From there it can walk anywhere on the machine — the setting picks the starting point, it does not fence anything in."
            value={value("repositoriesDirectory")}
            placeholder={inherited("repositoriesDirectory")}
            locked={lock("repositoriesDirectory")}
            workspace={workspace?.id}
            onChange={(repositoriesDirectory) =>
              setSetting("repositoriesDirectory", repositoriesDirectory)
            }
          />
        </div>
      )}

      {active === "worktrees" && (
        <div className="form">
          <ListEditor
            label="Copied from the repository"
            hint="IDE and build-tool state, with the paths inside it rewritten to the worktree. Not build output: recreating that is a build, and a stale copy is worse than none."
            values={value("worktreeCopy") ?? inherited("worktreeCopy") ?? []}
            placeholder=".idea"
            locked={lock("worktreeCopy")}
            note={
              scope !== "global" && value("worktreeCopy") === undefined
                ? "inherited from Global"
                : undefined
            }
            onInherit={
              scope !== "global" && value("worktreeCopy") !== undefined
                ? () => dropSetting("worktreeCopy")
                : undefined
            }
            onChange={(worktreeCopy) => setSetting("worktreeCopy", worktreeCopy)}
          />
          {scope === "global" && !lock("worktreeCopy") && (
            <button className="link" onClick={() => set({ worktreeCopy: view.toolingDefault })}>
              restore the defaults ({view.toolingDefault.join(" ")})
            </button>
          )}
        </div>
      )}

      {/* The settings each extension declares, rendered generically from the declaration: the
          page knows the shape of the settings and nothing about what they mean. Stored under
          extensionSettings[name][key] at both scopes, where the extension reads them back down
          the precedence chain. */}
      {shown.map((extension: KnownExtension) =>
        active === `extension:${extension.name}` ? (
          <div className="form" key={extension.name}>
            {extension.settings.map((field: ExtensionSetting) => {
              const placeholder = asString(inheritedBagValue(extension.name, field.key)) ?? field.placeholder;
              const listed = asList(bagValue(extension.name, field.key));
              const inheritedList = asList(inheritedBagValue(extension.name, field.key));
              const ownList = bagValue(extension.name, field.key) !== undefined;
              return field.list ? (
                <ListEditor
                  key={field.key}
                  label={field.label}
                  hint={field.hint}
                  placeholder={field.placeholder}
                  values={listed.length || ownList ? listed : inheritedList}
                  locked={view.overriddenExtensions?.[extension.name]?.[field.key]}
                  note={
                    scope !== "global" && !ownList ? "inherited from Global" : undefined
                  }
                  onInherit={
                    scope !== "global" && ownList
                      ? () => dropBagValue(extension.name, field.key)
                      : undefined
                  }
                  onChange={(values) => setBagValue(extension.name, field.key, values)}
                />
              ) : (
                <Field
                  key={field.key}
                  label={field.label}
                  hint={field.hint}
                  placeholder={placeholder}
                  secret={field.secret}
                  value={asString(bagValue(extension.name, field.key))}
                  locked={view.overriddenExtensions?.[extension.name]?.[field.key]}
                  onChange={(next) => setBagValue(extension.name, field.key, next)}
                />
              );
            })}
          </div>
        ) : null,
      )}

      {active === "notifications" && (
        <div className="form">
          <CheckField
            label="Play a sound"
            hint="When a window starts waiting for you. Whether a notification appears at all is the app's own permission, in System Settings."
            // The flags are written as they are (see the note at the top of this file: an
            // `undefined` would be dropped by JSON and the merge would keep the old answer). In a
            // workspace the flag is one decision more than the global level's, and "use Global's"
            // takes it back.
            checked={value("notificationSound") ?? inherited("notificationSound") ?? true}
            note={
              scope !== "global" && value("notificationSound") === undefined
                ? "inherited"
                : undefined
            }
            onInherit={
              scope !== "global" && value("notificationSound") !== undefined
                ? () => dropSetting("notificationSound")
                : undefined
            }
            onChange={(sound) => setSetting("notificationSound", sound)}
          />
        </div>
      )}

      {active === "window" && (
        <div className="form">
          <CheckField
            label="Right-click menu"
            hint="The browser's own menu over the page: copy, paste, and — in a checkout — the inspector. Off leaves right-click to the page, which is what a browser would then not show either. The terminal is unaffected: its menu is tmux's."
            // Shown is the default, so an absent key reads as on (see the note at the top of this
            // file on flags and JSON).
            checked={value("contextMenu") ?? inherited("contextMenu") ?? true}
            note={
              scope !== "global" && value("contextMenu") === undefined ? "inherited" : undefined
            }
            onInherit={
              scope !== "global" && value("contextMenu") !== undefined
                ? () => dropSetting("contextMenu")
                : undefined
            }
            onChange={(on) => setSetting("contextMenu", on)}
          />
        </div>
      )}

      {active === "ideation" && (
        <div className="form wide">
          <TextArea
            label="Briefing for an agent"
            hint="Pasted into a change's terminal by the button on an idea. {id}, {title}, {plan} and {state} are filled from the change; clearing this returns to the built-in default."
            value={value("ideationPrompt")}
            placeholder={inherited("ideationPrompt")}
            onChange={(ideationPrompt) => setSetting("ideationPrompt", ideationPrompt)}
          />
          <MarkdownField
            label="Plan template"
            hint="The starting text of a new idea's PLAN.md, in the wizard's plan editor. Literal Markdown — nothing is filled in. Clearing this leaves new plans empty."
            value={value("planTemplate")}
            placeholder={inherited("planTemplate")}
            onChange={(planTemplate) => setSetting("planTemplate", planTemplate)}
          />
        </div>
      )}

      {active === "environment" && (
        <div className="form">
          <EnvEditor
            env={value("env") ?? {}}
            inherited={scope === "global" ? {} : (draft.env ?? effective.env)}
            onChange={(env) => setSetting("env", Object.keys(env).length ? env : undefined)}
          />
        </div>
      )}

      {active === "extensions" && (
        <div className="form">
          <ExtensionToggles
            known={view.extensions}
            selected={(value("extensions") ?? inherited("extensions") ?? view.extensions.map((e) => e.name)).filter(
              (name) => view.extensions.some((e) => e.name === name),
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
    </div>
  );
}
