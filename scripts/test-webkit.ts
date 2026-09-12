/**
 * Runs the WebKit tests on the engine Playwright ships, under rootless podman.
 *
 * `test/webkit.test.ts` skips where Playwright's WebKit cannot start: its bundle is built for
 * Ubuntu 24.04, so a host whose icu/libxml2/flite are other versions has no engine to drive.
 * The engine is still the one the app's windows use (WKWebView, WebKitGTK), so this runs the
 * same file where the bundle and its libraries match — Playwright's own image, with Bun added
 * (Containerfile.webkit).
 *
 *   sudo pacman -S podman fuse-overlayfs slirp4netns   # once
 *   bun run test:webkit
 *
 * The checkout is mounted and `node_modules` lives in a named volume, so the modules installed
 * for the host are never replaced by the container's. The first run pulls the image and installs
 * the dependencies; after that it is the length of the test file.
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const image = "iwe-webkit";
/** Named, not a path in the checkout: the container's modules must not become the host's. */
const modules = "iwe-webkit-node-modules";

/** Run a command in the checkout with this terminal attached, and answer its exit code. */
const run = async (cmd: string[]): Promise<number> => {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
};

if (!Bun.which("podman")) {
  console.error(
    "podman is not installed. On Arch:\n\n    sudo pacman -S podman fuse-overlayfs slirp4netns\n",
  );
  process.exit(1);
}

const built = await run(["podman", "build", "-f", "Containerfile.webkit", "-t", image, root]);
if (built !== 0) process.exit(built);

process.exit(
  await run([
    "podman",
    "run",
    "--rm",
    // Chromium and WebKit want more shared memory than the 64 MB container default.
    "--shm-size=1g",
    "-v",
    `${root}:/app:Z`,
    "-v",
    `${modules}:/app/node_modules`,
    "-w",
    "/app",
    image,
    "sh",
    "-c",
    "bun install --frozen-lockfile && bun test test/webkit.test.ts --timeout 30000",
  ]),
);
