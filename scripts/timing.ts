/**
 * Deadlines and layout settling for anything that drives a page: the browser tests and the
 * screenshot walks alike.
 *
 * They live in `scripts/` because tests and scripts both drive a page: `test/helpers.ts` has
 * import-time side effects (it mints a run token and makes a temp root as it loads), so a script
 * importing it would look like a test run to `scripts/clean-test.ts`. The test barrel re-exports
 * these two, and nothing here reads or writes anything but the page and the clock.
 */
import { cpus, loadavg } from "node:os";
import type { Page } from "playwright";

/** How contended the machine is right now, as a multiplier: 1 on an idle box, up to 4 when it is
 * oversubscribed. The suite runs beside whatever else is on the machine — agents, browsers,
 * editors — and a deadline tuned on an idle box is a cascade waiting to happen. The one-minute
 * load is measured against a quarter of the cores, so a machine busy enough to slow a browser
 * test down scales its deadlines. */
const loadFactor = (): number => {
  const cores = Math.max(1, cpus().length);
  const load = loadavg()[0] ?? 0;
  return Math.min(4, Math.max(1, load / Math.max(1, cores * 0.25)));
};

/** How long the suite is willing to wait, for a wait deadline or a test timeout alike.
 *
 * Waits are condition-driven throughout — a test never sleeps for a duration it guessed — but a
 * wait still needs a deadline, and that deadline is a claim about the machine's speed. `budget`
 * states each one normally (30s for a wait, 60s for a browser test) and scales them all by how
 * busy the machine is, plus `CORVI_TEST_WAIT_SCALE` for CI to state a factor of its own (`3`
 * triples every deadline and every test timeout) — instead of the tests growing deadlier guesses.
 * The scaling is multiplicative on purpose: a wait's deadline must stay inside its test's timeout,
 * and scaling both together keeps that true whatever the factor. */
export const budget = (ms: number): number =>
  Math.round(ms * loadFactor() * (Number(process.env.CORVI_TEST_WAIT_SCALE) || 1));

/** Wait until the page has stopped laying itself out: fonts are loaded, and the document and the
 * scrollable content keep the same size for a quiet window. A single read after `waitForSelector`
 * can land before a sibling card's first answer or a font's swap, which is what turns a layout
 * assertion into a flaky one. */
export const settleLayout = async (page: Page, budgetMs = budget(5_000)): Promise<void> => {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForFunction(
    (quietMs: number) => {
      const state = window as unknown as { __corviSettle?: { key: string; since: number } };
      const content = document.querySelector<HTMLElement>(".content");
      const key = [
        window.innerWidth,
        window.innerHeight,
        document.documentElement.scrollWidth,
        document.documentElement.scrollHeight,
        content?.scrollWidth ?? -1,
        content?.scrollHeight ?? -1,
        content?.clientWidth ?? -1,
        content?.clientHeight ?? -1,
      ].join(":");
      const now = performance.now();
      const since = state.__corviSettle?.key === key ? state.__corviSettle.since : now;
      state.__corviSettle = { key, since };
      return now - since >= quietMs;
    },
    budget(300),
    { polling: "raf", timeout: budgetMs },
  );
};
