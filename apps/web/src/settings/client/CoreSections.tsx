import { type JSX } from "react";
import { CheckField, DirectoryField, EnvEditor, ListEditor, MarkdownField } from "./SettingsFields.tsx";
import type { SettingsScope } from "./settingsScope.ts";

/**
 * The core scoped sections: where changes live, what a worktree inherits, a new idea's plan
 * template, the environment variables a scope adds, and the two window behaviours.
 *
 * Each draws this scope's value over the inherited placeholder and hands the decision back
 * through `scope` — the page owns the inheritance chain and the draft.
 */

export function LocationsSection({
  scope,
  workspaceId,
}: {
  scope: SettingsScope;
  /** The workspace the directory picker opens against; the global scope has none. */
  workspaceId?: string;
}): JSX.Element {
  return (
    <div className="form">
      <DirectoryField
        label="Changes root"
        hint="One directory per change: its worktrees and its change.json."
        value={scope.value("changesRoot")}
        placeholder={scope.inherited("changesRoot")}
        locked={scope.lock("changesRoot")}
        workspace={workspaceId}
        onChange={(changesRoot) => scope.set("changesRoot", changesRoot)}
      />
      <DirectoryField
        label="Archive root"
        hint="Where completed changes are moved, so the changes root holds the work in flight."
        value={scope.value("archiveRoot")}
        placeholder={scope.inherited("archiveRoot")}
        locked={scope.lock("archiveRoot")}
        workspace={workspaceId}
        onChange={(archiveRoot) => scope.set("archiveRoot", archiveRoot)}
      />
      <DirectoryField
        label="Repositories directory"
        hint="Where the repository browser opens. From there it can walk anywhere on the machine — the setting picks the starting point, it does not fence anything in."
        value={scope.value("repositoriesDirectory")}
        placeholder={scope.inherited("repositoriesDirectory")}
        locked={scope.lock("repositoriesDirectory")}
        workspace={workspaceId}
        onChange={(repositoriesDirectory) => scope.set("repositoriesDirectory", repositoriesDirectory)}
      />
    </div>
  );
}

export function WorktreesSection({
  scope,
  toolingDefault,
  onRestoreDefaults,
}: {
  scope: SettingsScope;
  /** What the setting is when it is not set, so offering it back can name it. */
  toolingDefault: readonly string[];
  onRestoreDefaults: () => void;
}): JSX.Element {
  return (
    <div className="form">
      <ListEditor
        label="Copied from the repository"
        hint="IDE and build-tool state, with the paths inside it rewritten to the worktree. Not build output: recreating that is a build, and a stale copy is worse than none."
        values={scope.value("worktreeCopy") ?? scope.inherited("worktreeCopy") ?? []}
        placeholder=".idea"
        locked={scope.lock("worktreeCopy")}
        note={
          scope.at !== "global" && scope.value("worktreeCopy") === undefined
            ? "inherited from Global"
            : undefined
        }
        onInherit={
          scope.at !== "global" && scope.value("worktreeCopy") !== undefined
            ? () => scope.drop("worktreeCopy")
            : undefined
        }
        onChange={(worktreeCopy) => scope.set("worktreeCopy", worktreeCopy)}
      />
      {scope.at === "global" && scope.lock("worktreeCopy") === undefined && (
        <button className="link" onClick={onRestoreDefaults}>
          restore the defaults ({toolingDefault.join(" ")})
        </button>
      )}
    </div>
  );
}

export function IdeationSection({ scope }: { scope: SettingsScope }): JSX.Element {
  return (
    <div className="form wide">
      <MarkdownField
        label="Plan template"
        hint="The starting text of a new idea's PLAN.md, in the wizard's plan editor. Literal Markdown — nothing is filled in. Clearing this leaves new plans empty."
        value={scope.value("planTemplate")}
        placeholder={scope.inherited("planTemplate")}
        onChange={(planTemplate) => scope.set("planTemplate", planTemplate)}
      />
    </div>
  );
}

export function EnvironmentSection({
  scope,
  inheritedEnv,
}: {
  scope: SettingsScope;
  /** The global environment this workspace falls back to, draft edits included. */
  inheritedEnv: Record<string, string>;
}): JSX.Element {
  return (
    <div className="form">
      <EnvEditor
        env={scope.value("env") ?? {}}
        inherited={scope.at === "global" ? {} : inheritedEnv}
        onChange={(env) => scope.set("env", Object.keys(env).length ? env : undefined)}
      />
    </div>
  );
}

export function NotificationsSection({ scope }: { scope: SettingsScope }): JSX.Element {
  return (
    <div className="form">
      <CheckField
        label="Play a sound"
        hint="When a window starts waiting for you. Whether a notification appears at all is the app's own permission, in System Settings."
        // The flags are written as they are (see the note at the top of the settings page: an
        // `undefined` would be dropped by JSON and the merge would keep the old answer). In a
        // workspace the flag is one decision more than the global level's, and "use Global's"
        // takes it back.
        checked={scope.value("notificationSound") ?? scope.inherited("notificationSound") ?? true}
        note={
          scope.at !== "global" && scope.value("notificationSound") === undefined ? "inherited" : undefined
        }
        onInherit={
          scope.at !== "global" && scope.value("notificationSound") !== undefined
            ? () => scope.drop("notificationSound")
            : undefined
        }
        onChange={(sound) => scope.set("notificationSound", sound)}
      />
    </div>
  );
}

export function WindowSection({ scope }: { scope: SettingsScope }): JSX.Element {
  return (
    <div className="form">
      <CheckField
        label="Right-click menu"
        hint="The browser's own menu over the page: copy, paste, and — in a checkout — the inspector. Off leaves right-click to the page, which is what a browser would then not show either. The terminal's own menu (copy, paste, find, links) follows this too."
        // Shown is the default, so an absent key reads as on (see the note at the top of the
        // settings page on flags and JSON).
        checked={scope.value("contextMenu") ?? scope.inherited("contextMenu") ?? true}
        note={scope.at !== "global" && scope.value("contextMenu") === undefined ? "inherited" : undefined}
        onInherit={
          scope.at !== "global" && scope.value("contextMenu") !== undefined
            ? () => scope.drop("contextMenu")
            : undefined
        }
        onChange={(on) => scope.set("contextMenu", on)}
      />
    </div>
  );
}
