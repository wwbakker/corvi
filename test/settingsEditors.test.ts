import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CheckField,
  EnvEditor,
  ExtensionToggles,
  ListEditor,
  MarkdownField,
  type KnownExtension,
} from "../apps/web/src/settings/client/SettingsFields.tsx";

/**
 * The settings editors render whatever the extensions declare and nothing vendor-specific, at
 * both scopes. What a scope cannot decide is shown as inherited — with a way back to it — so an
 * empty field never hides what applies.
 */
const extensions: KnownExtension[] = [
  {
    name: "azure-devops",
    title: "Azure DevOps",
    settings: [{ key: "organization", label: "Organisation", placeholder: "the global setting" }],
  },
  { name: "jira", title: "Jira", settings: [] },
];

test("the extension toggles draw the resolved selection and hand back the truth", () => {
  const html = renderToStaticMarkup(
    createElement(ExtensionToggles, {
      known: extensions,
      selected: ["azure-devops"],
      onChange: () => {},
    }),
  );
  expect(html).toContain("Azure DevOps");
  expect(html).toContain("Jira");
  // The selection is concrete: the absent-means-all rule is folded away by the caller.
  expect(html).toContain('type="checkbox" checked=""'); // azure-devops off
  expect((html.match(/checked=""/g) ?? []).length).toBe(1);
});

test("the env editor shows the scope's own rows and the inherited ones read-only", () => {
  const html = renderToStaticMarkup(
    createElement(EnvEditor, {
      env: { GH_CONFIG_DIR: "~/.config/gh-client" },
      inherited: { GH_CONFIG_DIR: "~/.config/gh", AZURE_CONFIG_DIR: "~/.azure" },
      onChange: () => {},
    }),
  );
  expect(html).toContain('value="~/.config/gh-client"');
  // A key the scope sets wins, so its inherited row stays out of the way.
  expect(html).not.toContain('value="~/.config/gh"');
  // The rest of the global entries ride along, read-only, named as inherited.
  expect(html).toContain('value="~/.azure"');
  expect(html).toContain("inherited");
});

test("a decision that is not this scope's own says so, and can be given back", () => {
  const inherited = renderToStaticMarkup(
    createElement(CheckField, {
      label: "Play a sound",
      checked: true,
      note: "inherited",
      onChange: () => {},
    }),
  );
  expect(inherited).toContain("Play a sound");
  expect(inherited).toContain("inherited");
  // Nothing to give back: the scope already inherits.
  expect(inherited).not.toContain("use Global");

  const own = renderToStaticMarkup(
    createElement(CheckField, {
      label: "Play a sound",
      checked: false,
      onInherit: () => {},
      onChange: () => {},
    }),
  );
  expect(own).toContain("use Global");
});

test("a list the scope inherits says so, and an own one can be given back", () => {
  const inherited = renderToStaticMarkup(
    createElement(ListEditor, {
      label: "Copied from the repository",
      values: [".idea"],
      note: "inherited from Global",
      onChange: () => {},
    }),
  );
  expect(inherited).toContain('value=".idea"');
  expect(inherited).toContain("inherited from Global");
  expect(inherited).not.toContain("use Global");

  const own = renderToStaticMarkup(
    createElement(ListEditor, {
      label: "Copied from the repository",
      values: [".vscode"],
      onInherit: () => {},
      onChange: () => {},
    }),
  );
  expect(own).toContain('value=".vscode"');
  expect(own).toContain("use Global");
});

test("the plan template is edited in the Markdown editor, named and explained", () => {
  const html = renderToStaticMarkup(
    createElement(MarkdownField, {
      label: "Plan template",
      hint: "The starting text of a new idea in PLAN.md.",
      value: "# Scaffold",
      placeholder: "(none)",
      onChange: () => {},
    }),
  );
  expect(html).toContain("Plan template");
  expect(html).toContain("The starting text of a new idea in PLAN.md.");
  // The editor stands where the textarea would: the template is Markdown, source and all.
  expect(html).toContain("md-editor");
});
