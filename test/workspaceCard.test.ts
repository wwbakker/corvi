import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceCard, enablementPatch } from "../apps/web/src/workspace/client/WorkspaceCard.tsx";
import type { KnownExtension } from "../apps/web/src/settings/client/SettingsFields.tsx";
import type { Workspace } from "@corvi/configuration/config";

/**
 * The workspace card renders whatever the extensions declare and nothing vendor-specific:
 * organisation and project come from the azure-devops extension's own `workspaceSettings`
 * like every other per-workspace field.
 */
const azureDevops: KnownExtension = {
  name: "azure-devops",
  title: "Azure DevOps",
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
    { id: "client", name: "Client", extensionSettings: { "azure-devops": { organization: "acme" } } },
    [azureDevops],
  );
  expect(html).toContain("Organisation");
  expect(html).toContain("Project");
  // The declared value is bound where the extension reads it back.
  expect(html).toContain('value="acme"');
});

test("the workspace card offers the repositories directory, the global setting as its placeholder", () => {
  const html = render({ id: "client", name: "Client" }, [azureDevops]);
  expect(html).toContain("Repositories directory");
  expect(html).toContain('placeholder="the global setting"');
  expect(html).toContain("Browse");

  const own = render(
    { id: "client", name: "Client", repositoriesDirectory: "/tmp/client-repos" },
    [azureDevops],
  );
  expect(own).toContain('value="/tmp/client-repos"');
});

test("the workspace card has no azure section left", () => {
  const html = render({ id: "client", name: "Client" }, [azureDevops]);
  // The generic fields are there, but the vendor toggle and its dedicated controls are gone.
  expect(html).toContain("Organisation");
  expect(html).not.toContain("This context has Azure DevOps");
});

test("a disabled extension's per-workspace settings are not rendered", () => {
  const html = render({ id: "client", name: "Client", extensions: ["github"] }, [azureDevops]);
  expect(html).not.toContain("Organisation");
});

test("enablementPatch writes the extensions list", () => {
  const workspace: Workspace = { id: "client", name: "Client", extensions: ["github"] };
  expect(enablementPatch(workspace, ["github", "azure-devops"])).toEqual({
    extensions: ["github", "azure-devops"],
  });
  expect(enablementPatch(workspace, ["github"])).toEqual({ extensions: ["github"] });
  expect(enablementPatch(workspace, [])).toEqual({ extensions: [] });
  expect(enablementPatch({ id: "c", name: "C" }, ["azure-devops"])).toEqual({
    extensions: ["azure-devops"],
  });
});
