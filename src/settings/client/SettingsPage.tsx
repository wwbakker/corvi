import { type JSX, useEffect, useState } from "react";
import { api, put } from "../../app-root/api.ts";
import { DEFAULT_WORKSPACE, type Config } from "../../domain/config.ts";
// The settings vocabulary lives in the module's model.ts, so the browser bundle gets none of
// the server's file handling with it.
import type { Settings, SettingsView } from "../model.ts";
import type { ExtensionSetting } from "../../extension-host/api.ts";
import { CheckField, DirectoryField, Field, ListEditor, TextArea, type KnownExtension } from "./SettingsFields.tsx";
import { WorkspaceCard } from "../../workspace/client/WorkspaceCard.tsx";

/**
 * Everything that lives in the config file, edited here rather than in an editor.
 *
 * The file stays the source of truth and stays hand-editable — this writes it, and the server
 * puts it into effect at once. Which is why the page is a thin thing: it knows the shape of the
 * settings and nothing about what they mean.
 *
 * Two conventions run through it. An empty field is "not set", and shows the value that applies
 * anyway as its placeholder, so the difference between a default and a decision stays visible.
 * And a setting an environment variable is overriding is locked, with the variable named: the
 * variable wins, so an editable box would be a lie.
 *
 * A third is the write's own: the server merges what it is given over the file it already has, so a
 * field left out of the request keeps whatever the file said. Clearing is therefore always a
 * *value* — an empty string, a `false` — and never "nothing", because JSON drops a key whose value
 * is `undefined` and the merge then keeps the old answer. That is why the checkboxes write the flag
 * itself instead of an `undefined` meaning "the default". 
 */

/** The draft as the page holds it: the file's contents, edited. */
type Draft = Settings;

export function SettingsPage({ onSaved }: { onSaved: () => void }): JSX.Element {
  const [view, setView] = useState<SettingsView>();
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // Which section is on screen. A view, not part of the draft: saving does not change it.
  const [tab, setTab] = useState("locations");

  useEffect(() => {
    api<SettingsView>("/settings")
      .then((v) => {
        setView(v);
        setDraft(v.file);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

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
  // The extensions' server-wide settings live in the bag, under the extension's own name. A
  // value is one string or a list of them; the save prunes the empties — empty means unset.
  const setExtensionGlobal = (name: string, key: string, value: string | string[]): void => {
    set({
      extensionSettings: {
        ...draft.extensionSettings,
        [name]: { ...(draft.extensionSettings?.[name] ?? {}), [key]: value },
      },
    });
  };
  const globalString = (value: string | string[] | undefined): string | undefined =>
    typeof value === "string" ? value : undefined;
  const globalList = (value: string | string[] | undefined): string[] =>
    Array.isArray(value) ? value : [];
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.file);

  const save = (): void => {
    setSaving(true);
    setError(undefined);
    put<SettingsView>("/settings", draft)
      .then((v) => {
        setView(v);
        setDraft(v.file);
        setSaved(true);
        // The sidebar's contexts come from the same file: it should not still be showing a
        // workspace that has just been renamed away.
        onSaved();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  // The page's sections, one tab each: the fixed ones, the extensions' own settings in the order
  // they loaded, then the contexts. The tab carries the heading, so the content below omits it.
  // Stable ids, so a save that reloads the view leaves you where you were.
  const tabs = [
    { id: "locations", label: "Locations" },
    { id: "worktrees", label: "Worktrees" },
    { id: "extensions", label: "Extensions" },
    ...view.extensions
      .filter((extension) => extension.globalSettings.length)
      .map((extension) => ({ id: `extension:${extension.name}`, label: extension.title })),
    { id: "notifications", label: "Notifications" },
    { id: "ideation", label: "Ideation" },
    { id: "workspaces", label: "Workspaces" },
    { id: "window", label: "Window" },
  ];
  // An extension can be unloaded between saves; fall back to the first tab rather than to an
  // empty page.
  const active = tabs.some((one) => one.id === tab) ? tab : tabs[0]!.id;

  return (
    <div className="page settings">
      <header>
        <h2>Settings</h2>
        <span className="spacer" />
        {saved && !dirty && <span className="hint saved">saved</span>}
        <button className="create" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </header>
      <p className="hint">
        Written to <code>{view.path}</code>, which stays hand-editable. Saving takes effect at
        once — no restart.
      </p>
      {error && <div className="error-banner">{error}</div>}

      {/* The sections as tabs rather than one long scroll, in the same tab bar the change pages
          use. Extensions with settings of their own get their own tab; the ones without have
          nothing to show and no tab. */}
      <nav className="tabs">
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

      {active === "locations" && (
        <div className="form">
          <DirectoryField
            label="Changes root"
            hint="One directory per change: its worktrees and its change.json."
            value={draft.changesRoot}
            placeholder={effective.changesRoot}
            locked={lock("changesRoot")}
            onChange={(changesRoot) => set({ changesRoot })}
          />
          <DirectoryField
            label="Archive root"
            hint="Where completed changes are moved, so the changes root holds the work in flight."
            value={draft.archiveRoot}
            placeholder={effective.archiveRoot}
            locked={lock("archiveRoot")}
            onChange={(archiveRoot) => set({ archiveRoot })}
          />
          <DirectoryField
            label="Repositories directory"
            hint="Where the repository browser opens. From there it can walk anywhere on the machine — the setting picks the starting point, it does not fence anything in."
            value={draft.repositoriesDirectory}
            placeholder={effective.repositoriesDirectory}
            locked={lock("repositoriesDirectory")}
            onChange={(repositoriesDirectory) => set({ repositoriesDirectory })}
          />
        </div>
      )}

      {active === "worktrees" && (
        <div className="form">
          <ListEditor
            label="Copied from the repository"
            hint="IDE and build-tool state, with the paths inside it rewritten to the worktree. Not build output: recreating that is a build, and a stale copy is worse than none."
            values={draft.worktreeCopy ?? effective.worktreeCopy}
            placeholder=".idea"
            locked={lock("worktreeCopy")}
            onChange={(worktreeCopy) => set({ worktreeCopy })}
          />
          {!lock("worktreeCopy") && (
            <button className="link" onClick={() => set({ worktreeCopy: view.toolingDefault })}>
              restore the defaults ({view.toolingDefault.join(" ")})
            </button>
          )}
        </div>
      )}

      {active === "extensions" && (
        <div className="form">
          <ListEditor
            label="Out-of-tree extension paths"
            hint="TypeScript modules loaded beside the built-ins: a .ts file, or a directory whose immediate .ts files and */index.ts are loaded. ~/.config/corvi/extensions is searched as well, when it exists. Loading happens once, at startup — a change here needs a restart."
            values={draft.extensionPaths ?? []}
            placeholder="/home/me/my-extension"
            locked={lock("extensionPaths")}
            picker
            onChange={(extensionPaths) => set({ extensionPaths })}
          />
        </div>
      )}

      {/* The server-wide settings each extension declares, rendered generically from the
          declaration: the page knows the shape of the settings and nothing about what they
          mean. Stored under extensionSettings[name][key], where the extension reads them back
          with the top-level config fields as the fallback chain's tail. */}
      {view.extensions.map((extension: KnownExtension) =>
        extension.globalSettings.length && active === `extension:${extension.name}` ? (
          <div className="form" key={extension.name}>
            {extension.globalSettings.map((field: ExtensionSetting) =>
              field.list ? (
                <ListEditor
                  key={field.key}
                  label={field.label}
                  hint={field.hint}
                  placeholder={field.placeholder}
                  values={globalList(draft.extensionSettings?.[extension.name]?.[field.key])}
                  locked={view.overriddenExtensions?.[extension.name]?.[field.key]}
                  onChange={(values) => setExtensionGlobal(extension.name, field.key, values)}
                />
              ) : (
                <Field
                  key={field.key}
                  label={field.label}
                  hint={field.hint}
                  placeholder={field.placeholder}
                  value={globalString(draft.extensionSettings?.[extension.name]?.[field.key])}
                  locked={view.overriddenExtensions?.[extension.name]?.[field.key]}
                  onChange={(value) => setExtensionGlobal(extension.name, field.key, value)}
                />
              ),
            )}
          </div>
        ) : null,
      )}

      {active === "window" && (
        <div className="form">
          <CheckField
            label="Right-click menu"
            hint="The browser's own menu over the page: copy, paste, and — in a checkout — the inspector. Off leaves right-click to the page, which is what a browser would then not show either. The terminal is unaffected: its menu is tmux's."
            // Shown is the default, so an absent key reads as on, and the flag is written as it is
            // (see the note at the top of this file: an `undefined` would be dropped by JSON and the
            // merge would keep the old answer).
            checked={draft.contextMenu ?? true}
            onChange={(on) => set({ contextMenu: on })}
          />
        </div>
      )}

      {active === "notifications" && (
        <div className="form">
          <CheckField
            label="Play a sound"
            hint="When a window starts waiting for you. Whether a notification appears at all is the app's own permission, in System Settings."
            // The same trap as the right-click menu above, and the same fix: the flag is written,
            // never an `undefined` that JSON drops.
            checked={draft.notificationSound ?? true}
            onChange={(sound) => set({ notificationSound: sound })}
          />
        </div>
      )}

      {active === "ideation" && (
        <div className="form wide">
          <TextArea
            label="Briefing for an agent"
            hint="Pasted into a change's terminal by the button on an idea. {id}, {title}, {plan} and {state} are filled from the change; clearing this returns to the built-in default."
            value={draft.ideationPrompt}
            placeholder={effective.ideationPrompt}
            onChange={(ideationPrompt) => set({ ideationPrompt })}
          />
        </div>
      )}

      {active === "workspaces" && (
        <>
          <p className="hint">
            A context you work in: a client, or your own projects. Not only a filter — the
            extension switches decide what it has at all, and one without the Azure DevOps
            extension has no Azure DevOps page and no pipelines to look for.
          </p>
          <div className="form">
            {(draft.workspaces ?? []).map((workspace, index) => (
              <WorkspaceCard
                key={index}
                workspace={workspace}
                extensions={view.extensions}
                onChange={(next) =>
                  set({
                    workspaces: (draft.workspaces ?? []).map((w, i) => (i === index ? next : w)),
                  })
                }
                onRemove={() =>
                  set({ workspaces: (draft.workspaces ?? []).filter((_, i) => i !== index) })
                }
              />
            ))}
            {!(draft.workspaces ?? []).length && (
              <WorkspaceCard
                workspace={DEFAULT_WORKSPACE}
                extensions={view.extensions}
                onChange={(next) => set({ workspaces: [next] })}
              />
            )}
            <button
              className="add"
              onClick={() =>
                set({ workspaces: [...(draft.workspaces ?? []), { id: "", name: "" }] })
              }
            >
              + add a workspace
            </button>
          </div>
        </>
      )}
    </div>
  );
}
