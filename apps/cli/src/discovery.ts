/**
 * Finding the server to talk to.
 *
 * The app picks a fresh port at each launch, so the CLI cannot be told one at install time. It
 * collects candidates from every clue it has, in trust order — an explicit URL, `CORVI_URL`, the
 * records the server writes at startup, the pid-files the desktop window writes, and finally the
 * dev default — probes each one with `GET /api/identity`, and picks an answering server. When a
 * change is named it must be one the server owns, which is what makes several servers (a dev
 * server and the app) safe to have running at once.
 *
 * A clue is a hint, never an authority: an unreachable record or pid-file is a failed probe, not
 * an error. Only "nobody answered", or "several answered and the change is ambiguous", is.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";

import { makeChangesClient } from "@corvi/client";
import { ID, env, stateDir } from "@corvi/configuration/node";
import { InstanceRecordSchema, type InstanceRecord } from "@corvi/contracts/instance";

import { CliFailure, EXIT } from "./errors.ts";

/** Every instance record and pid-file shares this prefix, in the state directory. */
const FILE_PREFIX = `${ID}-app-`;
/** The port the server uses when nothing else says otherwise (`bun run dev`, `bun start`). */
const DEV_PORT = 4000;

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/** The instance records in `dir`, dropping any that do not parse (a crashed or foreign writer). */
export const instanceRecords = async (dir: string = stateDir()): Promise<readonly InstanceRecord[]> => {
  const names = await readdir(dir).catch(() => [] as string[]);
  const records: InstanceRecord[] = [];
  for (const name of names) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith(".json")) continue;
    const text = await readFile(join(dir, name), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    try {
      records.push(Schema.decodeUnknownSync(InstanceRecordSchema)(JSON.parse(text)));
    } catch {
      // A record that does not parse is a hint, not a failure.
    }
  }
  return records;
};

/** The ports named by the desktop window's pid-files (`<id>-app-<port>.pid`). */
export const pidFilePorts = async (dir: string = stateDir()): Promise<readonly number[]> => {
  const names = await readdir(dir).catch(() => [] as string[]);
  const ports: number[] = [];
  for (const name of names) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith(".pid")) continue;
    const port = Number(name.slice(FILE_PREFIX.length, -".pid".length));
    if (Number.isInteger(port) && port > 0) ports.push(port);
  }
  return ports;
};

export type Candidate = {
  readonly url: string;
  /** Where the candidate came from, for an error that says which clue was wrong. */
  readonly source: string;
};

export type CandidateInput = {
  /** `--server`, the most explicit clue. */
  readonly url?: string;
  /** `CORVI_URL`, injected into a change's tmux session beside its context. */
  readonly envUrl?: string;
  readonly dir?: string;
  readonly devPort?: number;
};

/** The candidates, deduplicated, most explicit first, ending with the dev default. */
export const serverCandidates = async (input: CandidateInput = {}): Promise<readonly Candidate[]> => {
  const configured = Number(process.env[env("PORT")]);
  const devPort = input.devPort ?? (Number.isFinite(configured) ? configured : DEV_PORT);
  const raw: Candidate[] = [];
  if (input.url !== undefined && input.url !== "") raw.push({ url: input.url, source: "--server" });
  if (input.envUrl !== undefined && input.envUrl !== "")
    raw.push({ url: input.envUrl, source: "CORVI_URL" });
  for (const record of await instanceRecords(input.dir))
    raw.push({ url: record.url, source: `record for port ${record.port}` });
  for (const port of await pidFilePorts(input.dir))
    raw.push({ url: `http://127.0.0.1:${port}`, source: `pid-file for port ${port}` });
  raw.push({ url: `http://127.0.0.1:${devPort}`, source: "the dev default" });

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const candidate of raw) {
    const url = stripTrailingSlash(candidate.url);
    if (seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, source: candidate.source });
  }
  return candidates;
};

/** What a probe answers: the change ids a candidate server knows. Throws when it does not
 * answer as a Corvi server at all. */
export type Probe = (url: string) => Promise<readonly string[]>;

/** The real probe: ask each candidate what it knows. */
export const clientProbe = (): Probe => async (url) => {
  const identity = await makeChangesClient({ baseUrl: url }).identity();
  return identity.changeIds;
};

export type ResolveInput = {
  readonly candidates: readonly Candidate[];
  readonly changeId?: string;
  readonly probe: Probe;
};

/** The one candidate to use. With a change named, exactly one answering server must own it; the
 * rest is ambiguity the caller resolves with `CORVI_URL`, not a guess the CLI makes. */
export const resolveServer = async (input: ResolveInput): Promise<Candidate> => {
  const answers: { readonly candidate: Candidate; readonly changeIds: readonly string[] }[] = [];
  for (const candidate of input.candidates) {
    const changeIds = await input.probe(candidate.url).catch(() => undefined);
    if (changeIds !== undefined) answers.push({ candidate, changeIds });
  }
  if (answers.length === 0) {
    throw new CliFailure(
      `no Corvi server answered (tried ${input.candidates.length} address(es); set CORVI_URL to name one, or start the app)`,
      EXIT.noServer,
    );
  }
  if (input.changeId === undefined) return answers[0]!.candidate;
  const knowing = answers.filter((answer) => answer.changeIds.includes(input.changeId!));
  if (knowing.length === 1) return knowing[0]!.candidate;
  const answered = answers.map((answer) => answer.candidate.url).join(", ");
  if (knowing.length === 0) {
    // One server answered and does not know the change: use it anyway, so the request itself
    // says 404 (a refusal, exit 4) rather than being reported as "no server" — the server is
    // right there. Only when several answered and none owns it is the address genuinely
    // ambiguous.
    if (answers.length === 1) return answers[0]!.candidate;
    throw new CliFailure(
      `no server owns change "${input.changeId}" (answered: ${answered}); set CORVI_URL to name one`,
      EXIT.noServer,
    );
  }
  throw new CliFailure(
    `several servers own change "${input.changeId}" (${knowing
      .map((answer) => answer.candidate.url)
      .join(", ")}); set CORVI_URL to choose one`,
    EXIT.noServer,
  );
};
