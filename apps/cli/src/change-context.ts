/**
 * Which change a command is about, without a flag.
 *
 * Three sources, most explicit first: `--change`, then `CORVI_CHANGE_ID` (which the server seeds
 * into every session of a change), then the nearest `change.json` at or above the working
 * directory. The last one is what makes `corvi change show` work when you are already standing in
 * a change.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The change file a directory carries. Kept as a literal, not imported: the CLI reads the
 * record's `id` field and nothing else, and a missing or newer record still has one. */
const CHANGE_FILE = "change.json";

/** The `id` of a parsed change record, or undefined when the text is not one. */
export const changeIdIn = (text: string): string | undefined => {
  try {
    const record: unknown = JSON.parse(text);
    if (typeof record !== "object" || record === null) return undefined;
    const id = (record as { id?: unknown }).id;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
};

/** Walk up from `start` until a directory holds a readable `change.json` with an id. */
export const changeIdFromDirectory = async (start: string): Promise<string | undefined> => {
  let dir = start;
  for (;;) {
    const text = await readFile(join(dir, CHANGE_FILE), "utf8").catch(() => undefined);
    if (text !== undefined) {
      const id = changeIdIn(text);
      if (id !== undefined) return id;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

export type ChangeContextInput = {
  readonly flag?: string;
  readonly env?: string;
  readonly cwd: string;
};

export const resolveChangeId = async (input: ChangeContextInput): Promise<string | undefined> => {
  if (input.flag !== undefined && input.flag !== "") return input.flag;
  if (input.env !== undefined && input.env !== "") return input.env;
  return changeIdFromDirectory(input.cwd);
};
