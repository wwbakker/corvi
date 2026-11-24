/**
 * Screenshots every surface the catalog names, on a running instance: the live walk,
 * `bun run shot`.
 *
 *   bun run shot                    # Chromium, against http://127.0.0.1:4000
 *   CORVI_HEADED=1 bun run shot     # with a window, when captures come out stale
 *   CORVI_ENGINE=webkit bun run shot
 *   CORVI_URL=... bun run shot
 *
 * What this file is: the walk of a running Corvi, for when you are looking at a dev server and
 * want the pages as pictures. It reads the change the catalog's change entries are about from the
 * instance itself — the first change that is not an idea; when there is none, those entries are
 * skipped and named — and writes `shots/live/NN-<surface>.png` in catalog order, honouring each
 * entry's theme and viewport. A surface that does not arrive is reported and fails the command: a
 * person running this wants to know which page did not come up, not a folder that quietly holds
 * fewer pictures. A surface whose setup needs content a brand-new instance does not have — an
 * action file to edit, an uncommitted change to review — is skipped with a line naming it and the
 * reason, and the rest are still captured. The distinction is the walk's: a failed setup is fatal
 * in `bun run screens`, whose fixture promises that content.
 *
 * Two shots cannot race on `shots/live`: the walk holds `shots/live.lock` (`scripts/screen-lock.ts`).
 *
 * What it is not: a comparison and not a fixture. It starts no server, builds nothing, stubs
 * nothing and compares nothing — the pictures are the instance's own data, including the answers
 * a machine without `az` or `gh` gives, because a `shot` of stub data would be a picture of
 * nothing. The comparison against an earlier revision is `bun run screens` (`scripts/screens.ts`),
 * which shares this walk's capture (`scripts/screen-capture.ts`) and skips this walk's `live`
 * entries (the terminal page and the Appearance section, which need a real shell or the settings
 * tree's own state).
 *
 * Against an isolated instance, never the installed app: a change page opens a terminal, and a
 * change's checkout is where the typed commands run. Chromium by default because that is what the
 * app is — the window is Electron, and Electron is Chromium (docs/manual/interface.md). WebKit is
 * a variable away for checking the page in another browser. A window that other windows cover
 * stops painting, and the capture then serves a stale frame; the launch flags keep it compositing,
 * and `CORVI_HEADED=1` opens it as a real window for the cases that still come out stale. Read a
 * shot against what you expect to see before trusting it.
 */
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { env } from "@corvi/configuration/node";
import { CAPTURE_ENGINE, captureSurface, takeActiveBrowser, type Finding } from "./screen-capture.ts";
import { SURFACES, changeRoute, fileNameOf, isChangeSurface } from "./screen-catalog.ts";
import { releaseLock, takeLock } from "./screen-lock.ts";
import { cleanupOnce, installSignalCleanup } from "./run-lifecycle.ts";

/** The instance to walk, from `CORVI_URL`: the dev server the app starts by default. */
const url = (process.env[env("URL")] ?? "http://127.0.0.1:4000").replace(/\/+$/, "");

/** Where the images go, from the repository root. Cleared at the start of every run, so the list
 * this run prints is the whole of what is there. */
const OUT = join("shots", "live");

/** This walk's own lock, beside the images it guards. */
const LOCK = resolve("shots", "live.lock");

/** Set by a signal: the walk stops rather than starting another surface, and its cleanup removes
 * the output directory only once this run has cleared it. */
let interrupted = false;
let outputOwned = false;

const headed = process.env[env("HEADED")] !== undefined;

/** A flag this walk does not take is refused rather than ignored: it has no flags by design (its
 * variables are `CORVI_URL`, `CORVI_HEADED` and `CORVI_ENGINE`), and a typo must not become a
 * quiet run against the default instance. */
const unknownFlag = process.argv.slice(2).find((argument) => argument.startsWith("--"));
if (unknownFlag !== undefined) {
  console.error(
    `shot: unknown flag ${unknownFlag}; shot takes no flags (use CORVI_URL, CORVI_HEADED and CORVI_ENGINE)`,
  );
  process.exit(2);
}

/** The instant relative times are measured from: now, because this is a picture of the instance
 * as it is. It is frozen for the run, so `3h ago` does not move between two surfaces. */
const now = new Date();

/** One change on the instance, as the catalog needs it: which change the change pages are about,
 * and whether it has started. */
type ListedChange = {
  readonly id: string;
  readonly state?: string;
};

/** What the instance lists. A refusal here is the command's whole failure: without the change
 * list there is nothing to walk, and guessing an id would photograph the plan fallback. */
const listedChanges = async (): Promise<ListedChange[]> => {
  const response = await fetch(`${url}/api/changes`);
  if (!response.ok) {
    throw new Error(`${url}/api/changes answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as ListedChange[];
};

/** The walk itself, with the lock already held. */
const walk = async (): Promise<void> => {
  const changes = await listedChanges();
  // The first change that is not an idea: an idea has no dashboard, no review and no terminal
  // worth a picture, and this is the change the catalog's change entries are about.
  const change = changes.find((record) => record.state !== "Ideation");
  const changeId = change?.id;

  const walkable = SURFACES.map((surface, index) => ({ surface, index })).filter(
    ({ surface }) => changeId !== undefined || !isChangeSurface(surface),
  );
  const skipped = SURFACES.map((surface, index) => ({ surface, index })).filter(
    ({ surface }) => changeId === undefined && isChangeSurface(surface),
  );

  outputOwned = true;
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  console.log(`shot: ${CAPTURE_ENGINE} against ${url}`);
  if (changeId === undefined) {
    const names = skipped.map(({ surface, index }) => fileNameOf(index, surface).replace(/\.png$/, ""));
    console.log(
      `shot: no change on this instance — ${names.join(", ")} ${skipped.length === 1 ? "was" : "were"} skipped`,
    );
  } else {
    console.log(`shot: change ${changeId}`);
  }

  const findings: Finding[] = [];
  const written: string[] = [];
  let skippedCount = 0;
  for (const { surface, index } of walkable) {
    if (interrupted) break;
    const captured = await captureSurface(surface, index, {
      pass: "after",
      out: OUT,
      origin: url,
      serverUrl: url,
      change: changeId ?? "",
      now,
      headed,
      // A running instance may have no action file to edit, no uncommitted change to review and
      // no plan text to fill the editor. That is content it does not have, not a surface that
      // failed to arrive, so the setup's failure is named as a skip. An arrival or data failure
      // is still fatal: a surface that does not come up is what this command exists to report.
      setupFailure: "skip",
    });
    findings.push(...captured.findings);
    const name = fileNameOf(index, surface);
    if (captured.skipped !== undefined) {
      skippedCount++;
      console.log(`  ${name}: skipped — ${captured.skipped.reason}`);
    } else if (captured.path !== undefined) {
      written.push(captured.path);
      console.log(`  ${captured.path}`);
    } else {
      console.log(`  ${name}: nothing captured`);
    }
  }

  if (interrupted) return;

  // Drift, reported rather than failed: a page or change tab this instance offers without a
  // catalog entry is exactly the gap this tool exists to close, and a live instance is where it
  // shows first. The comparison run (`scripts/screens.ts`) treats the same finding as fatal.
  const routes = new Set(SURFACES.map((surface) => surface.route));
  const drift = (surface: string, detail: string): void => {
    findings.push({ surface, kind: "coverage", detail, fatal: false, pass: "after" });
  };
  try {
    const response = await fetch(`${url}/api/pages`);
    if (!response.ok) throw new Error(`/api/pages answered ${response.status}`);
    const body = (await response.json()) as { pages?: { id: string }[] };
    for (const page of body.pages ?? []) {
      if (routes.has(`/${page.id}`)) continue;
      drift(page.id, `/api/pages offers "${page.id}" and no catalog entry captures /${page.id}`);
    }
  } catch (error) {
    console.warn(
      `shot: could not check page coverage: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (changeId !== undefined) {
    try {
      const response = await fetch(`${url}/api/changes/${encodeURIComponent(changeId)}/tabs`);
      if (!response.ok) throw new Error(`the change's /tabs answered ${response.status}`);
      const body = (await response.json()) as { tabs?: { id: string }[] };
      for (const tab of body.tabs ?? []) {
        if (routes.has(changeRoute(tab.id))) continue;
        drift(
          tab.id,
          `a change's /tabs offers "${tab.id}" and no catalog entry captures ${changeRoute(tab.id)}`,
        );
      }
    } catch (error) {
      console.warn(
        `shot: could not check change-tab coverage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const fatal = findings.filter((finding) => finding.fatal);
  console.log(
    `\n${written.length} of ${walkable.length} surfaces written to ${OUT}` +
      (skippedCount > 0 ? ` (${skippedCount} skipped)` : ""),
  );
  if (findings.length === 0) {
    console.log("no findings");
  } else {
    console.log(`${findings.length} finding(s):`);
    for (const finding of findings) {
      console.log(
        `  ${finding.fatal ? "fatal" : "note "}  ${finding.surface}: ${finding.kind}: ${finding.detail}`,
      );
    }
  }
  if (fatal.length > 0) {
    console.log(`\n${fatal.length} surface(s) did not arrive; the command fails.`);
    process.exitCode = 1;
  }
};

const main = async (): Promise<void> => {
  const token = `${Date.now().toString(36)}.${process.pid.toString(36)}`;
  const cleanUp = cleanupOnce(async (): Promise<void> => {
    const browser = takeActiveBrowser();
    if (browser !== undefined) await browser.close().catch(() => undefined);
    if (interrupted && outputOwned) await rm(OUT, { recursive: true, force: true });
    await releaseLock(LOCK, token);
  });
  installSignalCleanup(cleanUp, () => {
    interrupted = true;
  });
  const refused = await takeLock(LOCK, "shot", token);
  if (refused !== undefined) {
    console.error(refused);
    process.exitCode = 2;
    return;
  }
  try {
    await walk();
  } finally {
    await cleanUp();
  }
};

await main().catch((error: unknown) => {
  console.error(`shot: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
