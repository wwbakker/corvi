/** The Subagents page's file operations over the shared Markdown-file store: the scopes, the write
 * and delete, and the repository half.
 *
 * A profile that cannot be read is listed with that reason rather than hidden; a file that does
 * not parse is listed with its parser's reasons. The page is where both get fixed. */
import { Result, Effect } from "effect";

import { builtinProfilesDir } from "@corvi/agents/node";
import { parseProfileFile } from "@corvi/agents/profile";
import type {
  SubagentFileRefDto,
  SubagentFileWriteDto,
  SubagentFilesResponseDto,
  SubagentRepositoryFileRefDto,
  SubagentRepositoryFileWriteDto,
  SubagentRepositoryFilesResponseDto,
} from "@corvi/contracts/subagents";
import type { BadRequestError } from "@corvi/contracts/errors";
import type { Change } from "@corvi/changes/record";
import { makeMarkdownFiles } from "../../capabilities/markdownFiles.ts";
import { profileRootsFor } from "./run.ts";

const files = makeMarkdownFiles({
  dirName: "subagents",
  builtinDir: builtinProfilesDir,
  parse: (text) => {
    const parsed = parseProfileFile(text);
    return Result.isSuccess(parsed) ? { label: parsed.success.label } : { problems: parsed.failure.reasons };
  },
  unreadable: "problem",
  empty: "list",
  repositoryRoots: (change) => Effect.map(profileRootsFor(change), (roots) => roots.repositories),
});

/** What the page lists: the shipped profiles, the global ones, and each workspace's own. */
export const subagentFiles = (): Effect.Effect<SubagentFilesResponseDto> =>
  files.list() as Effect.Effect<SubagentFilesResponseDto>;

/** Write one profile file, refusing anything that is not a profile. */
export const writeSubagentFile = (
  body: SubagentFileWriteDto,
): Effect.Effect<SubagentFilesResponseDto, BadRequestError> =>
  files.write(body.scope, body.workspace, body.id, body.text) as Effect.Effect<
    SubagentFilesResponseDto,
    BadRequestError
  >;

/** Delete one profile file. Deleting a shadowing copy brings the shipped profile back. */
export const deleteSubagentFile = (
  ref: SubagentFileRefDto,
): Effect.Effect<SubagentFilesResponseDto, BadRequestError> =>
  files.remove(ref.scope, ref.workspace, ref.id) as Effect.Effect<SubagentFilesResponseDto, BadRequestError>;

/** The change's repository profiles, one block per checkout. */
export const repositorySubagentFiles = (change: Change): Effect.Effect<SubagentRepositoryFilesResponseDto> =>
  files.listRepositories(change) as Effect.Effect<SubagentRepositoryFilesResponseDto>;

/** Write one repository profile file. */
export const writeRepositorySubagentFile = (
  change: Change,
  body: SubagentRepositoryFileWriteDto,
): Effect.Effect<SubagentRepositoryFilesResponseDto, BadRequestError> =>
  files.writeRepository(change, body.repository, body.id, body.text) as Effect.Effect<
    SubagentRepositoryFilesResponseDto,
    BadRequestError
  >;

/** Delete one repository profile file from its checkout. */
export const deleteRepositorySubagentFile = (
  change: Change,
  ref: SubagentRepositoryFileRefDto,
): Effect.Effect<SubagentRepositoryFilesResponseDto, BadRequestError> =>
  files.removeRepository(change, ref.repository, ref.id) as Effect.Effect<
    SubagentRepositoryFilesResponseDto,
    BadRequestError
  >;
