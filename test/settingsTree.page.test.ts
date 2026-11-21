import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import {
  closePages,
  openEngine,
  startTestServer,
  stopTestServer,
  testTempDir,
  VIEWPORT,
  withPage,
} from "./helpers.ts";

/**
 * The settings page's tree and sticky scope through the product: the sections grouped, filtered
 * and expanded; a group row that says it has no settings; and a scope that stays where the
 * reader put it — including where it cannot edit the section on screen, which the pane says
 * rather than silently switching.
 *
 * The config seeds two local workspaces (Beta runs no extensions) and one remote workspace, so
 * the disabled-extension and remote messages have a real scope to land on.
 */
let browser: Browser;
const usable = await openEngine((opened) => {
  browser = opened;
});

let tmp: string;
let url: string;
let server: ReturnType<typeof Bun.spawn>;
let remote: { url: string; stop: () => void };

/** One section's row in the tree, by the label it shows. */
const settingsNode = (page: Page, label: string): Locator =>
  page.locator(".settings-tree").getByRole("button", { name: label, exact: true });

/** One scope tab inside the detail pane. */
const scopeTab = (page: Page, label: string): Locator =>
  page.locator(".settings-detail .tabs.scopes").getByRole("button", { name: label, exact: true });

const breadcrumb = async (page: Page): Promise<string> =>
  (await page.locator(".settings-detail .breadcrumb").innerText()).trim();

const currentScope = async (page: Page): Promise<string> =>
  (await page.locator(".settings-detail .tabs.scopes .tab.current").innerText()).trim();

const openSettings = async (page: Page): Promise<void> => {
  await page.goto(`${url}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".settings-tree");
};

beforeAll(async () => {
  if (!usable) return;
  tmp = await testTempDir("settings-tree-page");

  // The stand-in remote: its settings are its own, and the local page must only say so. The
  // event stream stays open, so the server's fan-in does not reconnect in a loop.
  const stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/workspaces")
        return Response.json({ workspaces: [{ id: "personal", name: "Personal" }], platform: "linux" });
      if (path === "/api/events")
        return new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "text/event-stream" },
        });
      return new Response("no such route", { status: 404 });
    },
  });
  remote = { url: `http://127.0.0.1:${stub.port}`, stop: () => void stub.stop(true) };

  await writeFile(
    join(tmp, "config.json"),
    JSON.stringify({
      workspaces: [
        { id: "alpha", name: "Alpha" },
        // An empty selection is "no extensions here", so Jira's page has no settings in Beta.
        { id: "beta", name: "Beta", settings: { extensions: [] } },
        { id: "hosted", name: "Hosted", remote: { url: remote.url, workspace: "personal" } },
      ],
    }),
  );
  ({ server, url } = await startTestServer(tmp));
});

afterAll(async () => {
  if (!usable) return;
  await closePages(browser, "settings-tree");
  await browser?.close();
  server?.kill();
  remote?.stop();
  await stopTestServer(server, tmp);
  await rm(tmp, { recursive: true, force: true });
});

test.skipIf(!usable)(
  "the tree groups every section, filters by name, and opens what it matches",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await openSettings(page);

        // The four groups, in order, and every section under them from the start.
        expect(
          (await page.locator(".settings-tree .tree > li > .row > .node").allInnerTexts()).map((label) =>
            label.trim(),
          ),
        ).toEqual(["Workspace", "Appearance & Behavior", "Extensions", "Remote"]);
        for (const label of [
          "Contexts",
          "Locations",
          "Worktrees",
          "Ideation",
          "Environment",
          "Appearance",
          "Window",
          "Notifications",
          "Remote access",
          "Devices",
        ]) {
          expect(await settingsNode(page, label).count(), label).toBe(1);
        }

        // The extensions under Extensions are the ones that declare settings, in load order.
        const view = (await (await fetch(`${url}/api/settings`)).json()) as {
          extensions: { title: string; settings: unknown[] }[];
        };
        expect(
          (
            await page
              .locator(".settings-tree .tree-branch.group", { hasText: "Extensions" })
              .last()
              .locator(".children > .tree-branch > .row > .node")
              .allInnerTexts()
          ).map((label) => label.trim()),
        ).toEqual(view.extensions.filter((extension) => extension.settings.length).map((ext) => ext.title));

        // Closing a group hides exactly its sections, and the toggle says which way it goes.
        await page.locator(".settings-tree").getByRole("button", { name: "Collapse Workspace" }).click();
        expect(await settingsNode(page, "Locations").count()).toBe(0);
        expect(await settingsNode(page, "Contexts").count()).toBe(0);
        expect(await settingsNode(page, "Appearance").count()).toBe(1);
        await page.locator(".settings-tree").getByRole("button", { name: "Expand Workspace" }).click();
        expect(await settingsNode(page, "Locations").count()).toBe(1);

        // A filter keeps the matching groups and sections, and opens a group whose section it
        // found — even one the reader had closed.
        await page.getByLabel("Filter settings").fill("wind");
        expect(await settingsNode(page, "Window").count()).toBe(1);
        expect(await settingsNode(page, "Workspace").count()).toBe(0);
        expect(await settingsNode(page, "Locations").count()).toBe(0);
        // Filtering keeps every surviving group open, so its toggle would only record a state
        // nobody can see: it is disabled for the duration.
        expect(
          await page
            .locator(".settings-tree")
            .getByRole("button", { name: "Collapse Appearance & Behavior" })
            .isDisabled(),
        ).toBe(true);
        await page.getByLabel("Filter settings").fill("");

        // Closing a group hides exactly its sections; filtering then reaches into it.
        await page.locator(".settings-tree").getByRole("button", { name: "Collapse Workspace" }).click();
        expect(await settingsNode(page, "Worktrees").count()).toBe(0);
        await page.getByLabel("Filter settings").fill("worktrees");
        expect(await settingsNode(page, "Workspace").count()).toBe(1);
        expect(await settingsNode(page, "Worktrees").count()).toBe(1);
        expect(await settingsNode(page, "Window").count()).toBe(0);

        // Clearing the filter leaves the group the reader closed closed: filtering is a look, not
        // a change to where they were.
        await page.getByLabel("Filter settings").fill("");
        expect(await settingsNode(page, "Worktrees").count()).toBe(0);
        await page.locator(".settings-tree").getByRole("button", { name: "Expand Workspace" }).click();
        expect(await settingsNode(page, "Worktrees").count()).toBe(1);

        // A filter that matches nothing says so rather than looking like an empty tree.
        await page.getByLabel("Filter settings").fill("nothing at all");
        await page.getByText("nothing matches").waitFor();
      },
      VIEWPORT,
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "a group says it has no settings, and Extensions owns the switches",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await openSettings(page);

        // A pure group is selectable and says where the settings are; it has no scope bar and no
        // form, because there is nothing at that level to edit.
        await settingsNode(page, "Workspace").click();
        expect(await breadcrumb(page)).toBe("Workspace");
        await page.getByText("There are no settings at the group level").waitFor();
        expect(await page.locator(".settings-detail .form").count()).toBe(0);
        expect(await page.locator(".settings-detail .tabs.scopes").count()).toBe(0);

        // Extensions is a group that does own settings: the enable/disable switches, with the
        // scopes, since a workspace chooses its own selection.
        await settingsNode(page, "Extensions").click();
        expect(await breadcrumb(page)).toBe("Extensions");
        expect(await page.getByRole("checkbox", { name: "Jira" }).count()).toBe(1);
        expect(await page.locator(".settings-detail .tabs.scopes").count()).toBe(1);

        // Its children are ordinary scoped pages.
        await settingsNode(page, "Jira").click();
        expect(await breadcrumb(page)).toBe("Extensions \u203a Jira");
        await page.getByLabel("Transition on completing one").waitFor();
        expect(await currentScope(page)).toBe("Global");
      },
      VIEWPORT,
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "the scope is sticky across scoped, global-only and workspace-only sections",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await openSettings(page);

        // Pick a workspace on a scoped section.
        await settingsNode(page, "Locations").click();
        await scopeTab(page, "Alpha").click();
        expect(await currentScope(page)).toBe("Alpha");

        // Walking to another scoped section leaves it there; the checkbox reads Alpha's own
        // answer and offers the global one back.
        await settingsNode(page, "Window").click();
        expect(await breadcrumb(page)).toBe("Appearance & Behavior \u203a Window");
        expect(await currentScope(page)).toBe("Alpha");
        expect(await page.getByLabel("Right-click menu").isChecked()).toBe(true);

        // A global-only section hides the scope tabs, and coming back does not move the scope.
        await settingsNode(page, "Appearance").click();
        await page.waitForSelector(".theme-choices");
        expect(await page.locator(".settings-detail .tabs.scopes").count()).toBe(0);
        await settingsNode(page, "Window").click();
        expect(await currentScope(page)).toBe("Alpha");

        // Contexts is workspace-only: the sticky scope names the context being edited, and there
        // is no Global tab to pick.
        await settingsNode(page, "Contexts").click();
        expect(await page.getByLabel(/^Name/).inputValue()).toBe("Alpha");
        expect(await scopeTab(page, "Global").count()).toBe(0);
        expect(await page.getByRole("button", { name: "+ add a context" }).count()).toBe(1);

        // Sticky Global on the workspace-only view keeps Global and says why there is no form.
        await settingsNode(page, "Locations").click();
        await scopeTab(page, "Global").click();
        await settingsNode(page, "Contexts").click();
        await page.getByText("Contexts are workspace-specific").waitFor();
        expect(await page.getByLabel(/^Name/).count()).toBe(0);

        // "+ add a context" adds one and moves the scope to it, without saving anything.
        await page.getByRole("button", { name: "+ add a context" }).click();
        expect(await page.getByLabel(/^Name/).inputValue()).toBe("");
        expect(await currentScope(page)).toBe("Unnamed");
      },
      VIEWPORT,
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "a remote workspace is a scope whose sections say their settings live on the server",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await openSettings(page);

        await settingsNode(page, "Locations").click();
        await scopeTab(page, "Hosted").click();
        expect(await currentScope(page)).toBe("Hosted");
        await page.getByText("The settings of Hosted live on the server that hosts it").waitFor();
        expect(await page.getByLabel("Changes root").count()).toBe(0);

        // The same for the scoped group and its extensions: local switches would be a lie.
        await settingsNode(page, "Extensions").click();
        await page.getByText("The settings of Hosted live on the server that hosts it").waitFor();
        expect(await page.getByRole("checkbox", { name: "Jira" }).count()).toBe(0);
      },
      VIEWPORT,
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "removing the context the sticky scope points at resets it, and the remaining tabs follow",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await openSettings(page);

        // Contexts is the workspace-only view; its tabs are the workspaces themselves.
        await settingsNode(page, "Contexts").click();
        await scopeTab(page, "Alpha").click();
        expect(await page.getByLabel(/^Name/).inputValue()).toBe("Alpha");

        // Removing the context takes the scope with it: there is nothing left at that index, and
        // the workspace-specific note replaces the form rather than silently showing the Default.
        await page.getByRole("button", { name: "Remove this context" }).click();
        await page.getByText("Contexts are workspace-specific").waitFor();
        expect(await page.getByLabel(/^Name/).count()).toBe(0);

        // The tabs are the workspaces that remain, in their new order.
        expect(
          (await page.locator(".settings-detail .tabs.scopes .tab").allInnerTexts()).map((label) =>
            label.trim(),
          ),
        ).toEqual(["Beta", "Hosted"]);
        expect(await scopeTab(page, "Alpha").count()).toBe(0);
        expect(await scopeTab(page, "Global").count()).toBe(0);

        // And Global is the scope the other sections now open with.
        await settingsNode(page, "Locations").click();
        expect(await currentScope(page)).toBe("Global");
      },
      VIEWPORT,
    );
  },
  60_000,
);

test.skipIf(!usable)(
  "an extension page omits workspaces where the extension is disabled and keeps the scope",
  async () => {
    await withPage(
      browser,
      async (page) => {
        await openSettings(page);

        await settingsNode(page, "Locations").click();
        await scopeTab(page, "Beta").click();
        expect(await currentScope(page)).toBe("Beta");

        // Jira's page in a workspace that runs no extensions: the message, and no fields.
        await settingsNode(page, "Jira").click();
        expect(await breadcrumb(page)).toBe("Extensions \u203a Jira");
        await page.getByText("Jira is disabled in Beta").waitFor();
        expect(await page.getByLabel("Transition on completing one").count()).toBe(0);

        // Beta is not offered as a scope here, and the scope was not silently taken away from the
        // reader: returning to a section that Beta does scope shows it still selected.
        expect(await scopeTab(page, "Beta").count()).toBe(0);
        expect(await page.locator(".settings-detail .tabs.scopes .tab.current").count()).toBe(0);
        expect(await scopeTab(page, "Alpha").count()).toBe(1);
        await settingsNode(page, "Locations").click();
        expect(await currentScope(page)).toBe("Beta");
      },
      VIEWPORT,
    );
  },
  60_000,
);
