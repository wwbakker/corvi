/** Screenshots the running app so the UI can be inspected without a human describing it.
 *
 *   bun run shot                    # Chromium, against http://127.0.0.1:4000
 *   CORVI_HEADED=1 bun run shot     # with a window, when captures come out stale
 *   CORVI_ENGINE=webkit bun run shot
 *   CORVI_URL=... bun run shot
 *
 * Writes to shots/. Requires `bunx playwright install chromium` once (webkit too, only for the
 * other-engine run).
 *
 * Chromium by default because that is what the app is: the window is Electron, and Electron is
 * Chromium (docs/manual/interface.md). WebKit is a variable away for checking the page in
 * another browser — the page is a web page first, and browsers remain a first-class view.
 *
 * A window that other windows cover stops painting, and the capture then serves a frame from
 * whenever it last did — a shot that disagrees with the page. The launch flags keep it
 * compositing anyway; `CORVI_HEADED=1` opens it as a real window for the cases that still come
 * out stale. Read a shot against what you expect to see before trusting it. */
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { env } from "@corvi/configuration/node";

const url = process.env[env("URL")] ?? "http://127.0.0.1:4000";

/** The engine of the app's own window: Chromium, via Electron. `CORVI_ENGINE` overrides it. */
const windowEngine = (): "webkit" | "chromium" => "chromium";

const engineName = process.env[env("ENGINE")] ?? windowEngine();
const engine = engineName === "webkit" ? webkit : chromium;
await mkdir("shots", { recursive: true });

const browser = await engine.launch({
  headless: !process.env[env("HEADED")],
  args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
console.log(`${engineName} against ${url}`);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

const shot = async (name: string): Promise<void> => {
  // Bring the window up and let the last change settle: a capture taken mid-update shows the
  // form of a moment ago.
  await page.bringToFront();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `shots/${name}.png`, fullPage: true });
  console.log(`shots/${name}.png`);
};

await page.goto(url, { waitUntil: "networkidle" });
await shot("1-home");

await page.locator(".sidebar .ideas-row .create").click();
// One screen now: the seeded plan on the left, the sections on the right. The steps arrive
// with the wizard's fetch, and each is collapsed to its pick — a field with an "Edit…" that
// opens its own browser in a dialog — so the tool works against any configuration: an
// instance with an issue integration, or one without.
await page.waitForSelector(".wizard-body");
await page.waitForTimeout(500);
await shot("2-wizard");

// The jira story browser behind its field's "Edit…". Picking an issue names the change — by
// writing the plan's heading while it is still the template's — so the screen after this one
// shows the title following it.
const jiraEdit = page
  .locator(".wizard-sections .field", { has: page.locator("span.label", { hasText: "Jira" }) })
  .getByRole("button", { name: "Edit…" });
if (await jiraEdit.isVisible().catch(() => false)) {
  await jiraEdit.click();
  await page.waitForSelector("dialog[open]");
  await page.waitForTimeout(500);
  const issues = page.locator("dialog[open] .table tbody tr:not(.group)");
  if (await issues.first().isVisible().catch(() => false)) {
    await issues.first().click();
    await page.waitForTimeout(200);
  }
  await shot("2b-jira-browser");
  await page.locator("dialog[open]").getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(200);
}
await shot("3-wizard-named");

// The repositories behind their field's "Edit…": the same directory browser as always, in a
// dialog over the small list of what is picked.
await page
  .locator(".wizard-sections .repos-field")
  .getByRole("button", { name: "Edit…" })
  .click();
await page.waitForSelector("dialog[open] .browser");
// Tick the first repository, so the shot shows the browser in use. Rows settle when the listing
// arrives — the empty hint is not a row — and the first row is not always a repository: a
// starting directory of plain directories needs one step in first.
const rows = page.locator("dialog[open] .entries li:not(.hint)");
const add = page.locator("dialog[open] .entries button:enabled", { hasText: /^Add$/ }).first();
await rows.first().waitFor();
if (await add.isVisible().catch(() => false)) {
  await add.click();
} else {
  // A starting directory of plain directories needs one step in first — and one with nothing
  // to add yet (a bare instance) skips the pick rather than holding the captures up.
  const dir = page.locator("dialog[open] .entries button.dir").first();
  if (await dir.isVisible().catch(() => false)) {
    await dir.click();
    await rows.first().waitFor();
    if (await add.isVisible().catch(() => false)) await add.click();
  }
}
// The branch lists arrive with the row; the shot should show them.
await page.waitForTimeout(300);
await shot("4-wizard-repos");
await page.locator("dialog[open]").getByRole("button", { name: "Close" }).click();

if (errors.length) console.log("console errors:\n" + errors.join("\n"));

// The settings page: the two axes — the scope bar (Global and the workspaces) and the section
// tabs — so the inheritance a workspace shows can be read off the capture.
await page.goto(`${url}/settings`, { waitUntil: "networkidle" });
await shot("5-settings-global");
const ideation = page.locator(".tabs.sections .tab", { hasText: "Ideation" });
if (await ideation.isVisible().catch(() => false)) {
  await ideation.click();
  await page.waitForTimeout(200);
  await shot("5b-settings-ideation");
}
const scope = page.locator(".tabs.scopes .tab:not(.current)").first();
if (await scope.isVisible().catch(() => false)) {
  await scope.click();
  await page.waitForTimeout(200);
  await shot("6-settings-workspace");
  const environment = page.locator(".tabs.sections .tab", { hasText: "Environment" });
  if (await environment.isVisible().catch(() => false)) {
    await environment.click();
    await shot("7-settings-environment");
  }
}
// The Actions page and its editor: the files behind the menu, by scope, then one file in the
// editor's frame — the Markdown source with the fields' documentation beside it, the caret's
// field lit. The panel is toggled and put back where it was, so the captures never decide the
// preference for the instance being shot.
await page.goto(`${url}/actions`, { waitUntil: "networkidle" });
await shot("8-actions-list");
const edit = page.locator(".widget p").getByRole("button", { name: "Edit" }).first();
if (await edit.isVisible().catch(() => false)) {
  await edit.click();
  await page.waitForSelector(".actions-page.editing");
  await page.waitForSelector(".md-editor .cm-placeholder", { state: "detached" });
  await shot("9-actions-editor");
  // The caret on the frontmatter's first field lights its entry beside the editor.
  await page.locator(".cm-line").nth(1).click();
  await page.waitForTimeout(200);
  await shot("10-actions-editor-field");
  await page.getByRole("button", { name: "Hide docs" }).click();
  await page.waitForSelector(".action-docs", { state: "detached" });
  await shot("11-actions-editor-no-docs");
  await page.getByRole("button", { name: "Show docs" }).click();
  await page.waitForSelector(".action-docs");
}
if (errors.length) console.log("console errors:\n" + errors.join("\n"));
await browser.close();
