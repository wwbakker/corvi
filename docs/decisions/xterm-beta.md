# The xterm.js beta and the image addon patch

Status: the page's xterm.js packages are on the 6.1 beta for kitty graphics, and the image addon
carries a local patch, until a stable release has both.

| Decision | Reason and boundary |
| --- | --- |
| `apps/web` uses `@xterm/xterm` 6.1.0-beta and the matching beta of every addon, pinned exactly | Kitty graphics exist only in `@xterm/addon-image` 0.10.0-beta, which requires the 6.1 beta; pi's fullscreen mode (its default) draws images only in kitty graphics, and turns iTerm2 images off. The addons are moved together because each beta is built against the same core internals, and the WebGL renderer reads many of them. An exact pin, because a beta's next build may change what the page relies on: the scrollbar's class names already moved (`.xterm-scrollbar.xterm-vertical`). |
| `patches/@xterm%2Faddon-image@0.10.0-beta.334.patch` (applied by `bun install`) changes three things in the addon's kitty support | The protocol's lowercase deletes (`d=a`, `d=i`) remove placements and keep the uploaded image; the beta freed the image too. A placement the addon erases on its own (rows overwritten, the alternate screen cleared) now keeps its upload as well. pi's fullscreen redraw deletes every placement with `d=a` and places its images again by id with `a=p`, never uploading them twice, so without the patch every image disappeared on the first redraw. Upstream's own source marks both as TODOs. |
| The terminal host seeds `PI_IMAGE_PROTOCOL=kitty` | pi cannot detect the page as a kitty-graphics terminal. A value already in the environment stands. |
| Kitty uploads are kept per session in the page across a reattach, and a program that had drawn some is resized by one column and back (`apps/web/src/terminals/client/kittyImages.ts`) | The server's screen has no images, and the reset a reattach makes empties the addon. pi places images by id on a full redraw, which it makes only when the size changes. A reload or another window taking over still starts without them. |

## Leaving the beta

When a stable `@xterm/addon-image` has kitty graphics, check whether it keeps uploads on a
lowercase delete (`a=d,d=a`, then `a=p` must still draw) — the browser test "kitty graphics: an
image is uploaded once, re-placed by id after its placements are deleted, and deleted" says so.
Then move every `@xterm` package to that stable release, remove the patch and its
`patchedDependencies` entry, run the full suite, and delete this record.
