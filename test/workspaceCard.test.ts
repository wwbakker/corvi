import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceCard } from "../src/workspace/client/WorkspaceCard.tsx";
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
