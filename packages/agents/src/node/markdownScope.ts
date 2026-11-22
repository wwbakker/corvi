/** The scope reader shared by every Markdown file kind Corvi discovers (actions, subagent
 * profiles, harnesses): every `*.md` directly in one directory, read fresh. OS access stays
 * behind the `node` adapter entrypoint.
 *
 * A directory that is missing or unreadable is simply an empty scope — a scope the user has not
 * set up must not look like an error. A file that cannot be read is still returned, with
 * `readable: false`, so it is listed with a reason rather than hidden. */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { InternalError } from "@corvi/contracts/errors";

/** One `*.md` file on disk in a scope, before it is parsed. */
export type MarkdownScopeFile = {
  readonly id: string;
  readonly path: string;
  readonly text: string;
  readonly readable: boolean;
};

export const readMarkdownScope = (dir: string): Effect.Effect<readonly MarkdownScopeFile[]> =>
  Effect.gen(function* () {
    const names = yield* Effect.tryPromise({
      try: () => readdir(dir),
      catch: () => new InternalError({ message: `cannot read ${dir}` }),
    }).pipe(Effect.orElseSucceed(() => [] as string[]));
    const files: MarkdownScopeFile[] = [];
    for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
      const path = join(dir, name);
      const read = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: () => new InternalError({ message: `cannot read ${path}` }),
      }).pipe(Effect.result);
      files.push({
        id: name.slice(0, -3),
        path,
        text: read._tag === "Success" ? read.success : "",
        readable: read._tag === "Success",
      });
    }
    return files;
  });
