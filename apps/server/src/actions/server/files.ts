/** The Actions page's file operations over the shared Markdown-file store: the scopes, the write
 * and delete, and the repository half.
 *
 * The action-specific part is the brief: the shipped `brief` entry shows the text that actually
 * runs — the legacy `ideationPrompt` setting overrides its body while no `brief.md` shadows it —
 * so the picker previews and copies what the user has been sending. */
import { Result, Effect } from "effect";

import { parseActionFile, splitFrontmatter } from "@corvi/actions/model";
import { builtinActionsDir } from "@corvi/actions/node";
import type {
  ActionFileRefDto,
  ActionFileWriteDto,
  ActionFilesResponseDto,
  ActionRepositoryFileRefDto,
  ActionRepositoryFileWriteDto,
  ActionRepositoryFilesResponseDto,
} from "@corvi/contracts/actions";
import type { BadRequestError } from "@corvi/contracts/errors";
import type { Change } from "@corvi/changes/record";
import type { MarkdownFilesPage } from "../../capabilities/markdownFiles.ts";
import { settingsOf } from "../../workspace/server/index.ts";
import { makeMarkdownFiles } from "../../capabilities/markdownFiles.ts";
import { actionRootsFor } from "./run.ts";

const files = makeMarkdownFiles({
  dirName: "actions",
  builtinDir: builtinActionsDir,
  parse: (text) => {
    const parsed = parseActionFile(text);
    return Result.isSuccess(parsed) ? { label: parsed.success.label } : { problems: parsed.failure.reasons };
  },
  unreadable: "skip",
  empty: "skip",
  repositoryRoots: (change) => Effect.map(actionRootsFor(change), (roots) => roots.repositories),
});

/** The built-in brief as the page shows it: the legacy `ideationPrompt` replaces its body while
 * no user file shadows it, so the picker previews and copies what is actually sent. */
const withBrief = (page: MarkdownFilesPage): ActionFilesResponseDto => {
  const files = [...page.files];
  const shadowed = files.some((file) => file.id === "brief" && file.scope !== "builtin");
  const override = settingsOf().ideationPrompt;
  const builtIn = files.find((file) => file.id === "brief" && file.scope === "builtin");
  const split = builtIn === undefined ? undefined : splitFrontmatter(builtIn.text);
  if (!shadowed && override !== "" && builtIn && split) {
    files[files.indexOf(builtIn)] = {
      ...builtIn,
      text: `---\n${split.frontmatter}\n---\n${override}`,
    };
  }
  return { workspaces: page.workspaces, files };
};

/** What the page lists: the shipped files, the global ones, and each workspace's own. */
export const actionFiles = (): Effect.Effect<ActionFilesResponseDto> => Effect.map(files.list(), withBrief);

/** Write one action file, refusing anything that is not an action. The id is the filename, so it
 * has to look like one. */
export const writeActionFile = (
  body: ActionFileWriteDto,
): Effect.Effect<ActionFilesResponseDto, BadRequestError> =>
  Effect.map(files.write(body.scope, body.workspace, body.id, body.text), withBrief) as Effect.Effect<
    ActionFilesResponseDto,
    BadRequestError
  >;

/** Delete one action file. Deleting a shadowing `brief.md` brings the built-in brief back. */
export const deleteActionFile = (
  ref: ActionFileRefDto,
): Effect.Effect<ActionFilesResponseDto, BadRequestError> =>
  Effect.map(files.remove(ref.scope, ref.workspace, ref.id), withBrief) as Effect.Effect<
    ActionFilesResponseDto,
    BadRequestError
  >;

/** The change's repository actions, one block per checkout. */
export const repositoryActionFiles = (change: Change): Effect.Effect<ActionRepositoryFilesResponseDto> =>
  files.listRepositories(change) as Effect.Effect<ActionRepositoryFilesResponseDto>;

/** Write one repository action file. */
export const writeRepositoryActionFile = (
  change: Change,
  body: ActionRepositoryFileWriteDto,
): Effect.Effect<ActionRepositoryFilesResponseDto, BadRequestError> =>
  files.writeRepository(change, body.repository, body.id, body.text) as Effect.Effect<
    ActionRepositoryFilesResponseDto,
    BadRequestError
  >;

/** Delete one repository action file from its checkout. */
export const deleteRepositoryActionFile = (
  change: Change,
  ref: ActionRepositoryFileRefDto,
): Effect.Effect<ActionRepositoryFilesResponseDto, BadRequestError> =>
  files.removeRepository(change, ref.repository, ref.id) as Effect.Effect<
    ActionRepositoryFilesResponseDto,
    BadRequestError
  >;
