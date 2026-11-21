import { type JSX } from "react";
import type { ExtensionSetting } from "@corvi/contracts/integration";
import { Field, ListEditor, type KnownExtension } from "./SettingsFields.tsx";

/** How one extension's settings bag reads and writes at the scope on screen. */
export type ExtensionSettingsAccess = {
  value: (key: string) => string | string[] | undefined;
  inherited: (key: string) => string | string[] | undefined;
  set: (key: string, next: string | string[]) => void;
  drop: (key: string) => void;
  locked: (key: string) => string | undefined;
};

/**
 * The settings one extension declares, rendered generically from the declaration: the page knows
 * the shape of the settings and nothing about what they mean. Stored under
 * `extensionSettings[name][key]` at both scopes, where the extension reads them back down the
 * precedence chain.
 */
export function ExtensionSettingsSection({
  extension,
  scopeAt,
  access,
}: {
  extension: KnownExtension;
  /** "global", or a workspace's index — only to decide what "inherited" means. */
  scopeAt: "global" | number;
  access: ExtensionSettingsAccess;
}): JSX.Element {
  return (
    <div className="form">
      {extension.settings.map((field: ExtensionSetting) => {
        const placeholder = asString(access.inherited(field.key)) ?? field.placeholder;
        const listed = asList(access.value(field.key));
        const inheritedList = asList(access.inherited(field.key));
        const ownList = access.value(field.key) !== undefined;
        return field.list ? (
          <ListEditor
            key={field.key}
            label={field.label}
            hint={field.hint}
            placeholder={field.placeholder}
            values={listed.length || ownList ? listed : inheritedList}
            locked={access.locked(field.key)}
            note={scopeAt !== "global" && !ownList ? "inherited from Global" : undefined}
            onInherit={scopeAt !== "global" && ownList ? () => access.drop(field.key) : undefined}
            onChange={(values) => access.set(field.key, values)}
          />
        ) : (
          <Field
            key={field.key}
            label={field.label}
            hint={field.hint}
            placeholder={placeholder}
            secret={field.secret}
            value={asString(access.value(field.key))}
            locked={access.locked(field.key)}
            onChange={(next) => access.set(field.key, next)}
          />
        );
      })}
    </div>
  );
}

const asString = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const asList = (value: string | string[] | undefined): string[] => (Array.isArray(value) ? value : []);
