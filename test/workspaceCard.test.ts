import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceCard, enablementPatch } from "../src/workspace/client/WorkspaceCard.tsx";
import type { KnownExtension } from "../src/settings/client/SettingsFields.tsx";
import type { Workspace } from "../src/core/domain/config.ts";

/**
 * The workspace card renders whatever the extensions declare and nothing vendor-specific: the
 * azure controls are gone, and organisation and project come from the deployments extension's
 * own `workspaceSettings` like every other per-workspace field.
 */
const deployments: KnownExtension = {
  name: "deployments",
  title: "Deployments",
  workspaceSettings: [
    { key: "organization", label: "Organisation", placeholder: "the global setting" },
    { key: "project", label: "Project", placeholder: "the global setting" },
  ],
  globalSettings: [],
};

const render = (workspace: Workspace, extensions: KnownExtension[]): string =>
  renderToStaticMarkup(
    createElement(WorkspaceCard, { workspace, extensions, onChange: () => {} }),
  );

test("the workspace card renders a declared per-workspace setting generically", () => {
  const html = render(
    { id: "client", name: "Client", extensionSettings: { deployments: { organization: "acme" } } },
    [deployments],
  );
  expect(html).toContain("Organisation");
  expect(html).toContain("Project");
  // The declared value is bound where the extension reads it back.
  expect(html).toContain('value="acme"');
});

test("the workspace card has no azure section left", () => {
  const html = render({ id: "client", name: "Client" }, [deployments]);
  // The generic fields are there, but the vendor toggle and its dedicated controls are gone.
  expect(html).toContain("Organisation");
  expect(html).not.toContain("This context has Azure DevOps");
});

test("a disabled extension's per-workspace settings are not rendered", () => {
  const html = render({ id: "client", name: "Client", extensions: ["ci"] }, [deployments]);
  expect(html).not.toContain("Organisation");
});

test("switching Deployments on clears the legacy azure:false", () => {
  const workspace: Workspace = { id: "client", name: "Client", extensions: ["ci"], azure: false };

  // The switch that turns deployments on also clears the legacy fact: the card preserves keys it
  // does not know, so the field would otherwise keep winning for ever.
  expect(enablementPatch(workspace, ["ci", "deployments"])).toEqual({
    extensions: ["ci", "deployments"],
    azure: undefined,
  });
  // All-on is the absent list, and that turns deployments on too.
  expect(enablementPatch(workspace, undefined)).toEqual({ extensions: undefined, azure: undefined });
  // The cleared field leaves the written file, since JSON drops an undefined property.
  const written = { ...workspace, ...enablementPatch(workspace, ["ci", "deployments"]) };
  expect("azure" in (JSON.parse(JSON.stringify(written)) as object)).toBe(false);

  // Turning deployments off, or leaving it off, keeps the legacy fact as it was.
  expect(enablementPatch(workspace, ["ci"])).toEqual({ extensions: ["ci"] });
  expect(enablementPatch(workspace, [])).toEqual({ extensions: [] });
  // A workspace that never carried the legacy field is unchanged by the extra rule.
  expect(enablementPatch({ id: "c", name: "C" }, ["deployments"])).toEqual({
    extensions: ["deployments"],
  });
});
