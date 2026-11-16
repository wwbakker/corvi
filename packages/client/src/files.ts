/** The file operations both the Actions and Subagents pages use: one Markdown file per request,
 * by scope, plus the repository-scope block of one change.
 *
 * The two namespaces differ only in their paths and their response schemas; the request shapes,
 * the query spelling and the write bodies are the same, so they live here once. */
import type { Schema } from "effect";

import type { ChangeId } from "@corvi/contracts/changes";

import { request, type Send } from "./transport.ts";

export type FileWriteBody = {
  readonly scope: "global" | "workspace";
  readonly workspace?: string;
  readonly id: string;
  readonly text: string;
};

export type FileRef = Omit<FileWriteBody, "text">;

export type RepositoryWriteBody = {
  readonly repository: string;
  readonly id: string;
  readonly text: string;
};

export type RepositoryRef = Omit<RepositoryWriteBody, "text">;

export type FileOperations<L, R> = {
  readonly files: () => Promise<L>;
  readonly writeFile: (file: FileWriteBody) => Promise<L>;
  readonly deleteFile: (ref: FileRef) => Promise<L>;
  /** The repository-scope files of one change's checkouts — the Repositories view. */
  readonly repositoryFiles: (changeId: ChangeId) => Promise<R>;
  readonly writeRepositoryFile: (changeId: ChangeId, file: RepositoryWriteBody) => Promise<R>;
  readonly deleteRepositoryFile: (changeId: ChangeId, ref: RepositoryRef) => Promise<R>;
};

export const makeFileOperations = <L, R>(
  send: Send,
  options: {
    readonly filesPath: string;
    readonly repositoryPath: (changeId: ChangeId) => string;
    readonly filesSchema: Schema.ConstraintDecoder<L>;
    readonly repositoriesSchema: Schema.ConstraintDecoder<R>;
  },
): FileOperations<L, R> => ({
  files: async () => request(send, "GET", options.filesPath, options.filesSchema),
  writeFile: async (file) => request(send, "PUT", options.filesPath, options.filesSchema, { body: file }),
  deleteFile: async (ref) =>
    request(
      send,
      "DELETE",
      `${options.filesPath}?scope=${ref.scope}${
        ref.workspace ? `&workspace=${encodeURIComponent(ref.workspace)}` : ""
      }&id=${encodeURIComponent(ref.id)}`,
      options.filesSchema,
    ),
  repositoryFiles: async (changeId) =>
    request(send, "GET", options.repositoryPath(changeId), options.repositoriesSchema),
  writeRepositoryFile: async (changeId, file) =>
    request(send, "PUT", options.repositoryPath(changeId), options.repositoriesSchema, {
      body: file,
    }),
  deleteRepositoryFile: async (changeId, ref) =>
    request(
      send,
      "DELETE",
      `${options.repositoryPath(changeId)}?repository=${encodeURIComponent(ref.repository)}&id=${encodeURIComponent(ref.id)}`,
      options.repositoriesSchema,
    ),
});
