import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result } from "effect";

import { testTempDir } from "@corvi/test-support/temp";
import { parseHarnessFields, type HarnessFields } from "../src/harnessFields.ts";
import {
  describeHarnessError,
  mergeHarnessFiles,
  resolveHarness,
  resolveHarnessByKey,
  type HarnessDiscovery,
  type HarnessFileInput,
  type HarnessResolutionError,
  type ResolvedHarness,
} from "../src/harnessDiscovery.ts";
import { discoverHarnesses } from "../src/node/index.ts";

const fileOf = (
  id: string,
  source: HarnessFileInput["source"],
  fields: Record<string, unknown>,
  origin?: string,
): HarnessFileInput => ({
  id,
  source,
  origin,
  originLabel: origin,
  text: `---\n${JSON.stringify(fields)}\n---\n${id} notes`,
});

/** The overlay a referencing file contributes: its frontmatter fields, defaulted to empty
 * sections the way a harness file without a section is. */
const overlayOf = (source: Record<string, unknown>): HarnessFields => {
  const parsed = parseHarnessFields(source);
  if (Result.isFailure(parsed)) throw new Error(parsed.failure.reasons.join("; "));
  const { harness: _harness, ...fields } = parsed.success;
  return fields;
};

const BUILTINS: readonly HarnessFileInput[] = [
  fileOf("pi", "builtin", { label: "Pi", agent: "pi" }),
  fileOf("pi-bare", "builtin", {
    label: "Bare Pi",
    harness: "pi",
    extensions: { mode: "none" },
    skills: { mode: "none" },
  }),
  fileOf("opencode", "builtin", { label: "opencode", agent: "opencode" }),
];

const discoveryOf = (files: readonly HarnessFileInput[]): HarnessDiscovery =>
  mergeHarnessFiles([...BUILTINS, ...files]);

const resolved = (discovery: HarnessDiscovery, id: string, overlay?: HarnessFields): ResolvedHarness => {
  const result = resolveHarness(discovery, id, overlay);
  if (Result.isFailure(result)) throw new Error(describeHarnessError(result.failure));
  return result.success;
};

const failureOf = (result: Result.Result<unknown, HarnessResolutionError>): HarnessResolutionError => {
  if (Result.isSuccess(result)) throw new Error("expected a failure");
  return result.failure;
};

test("the real built-ins resolve to a chain that ends at pi", async () => {
  const dir = await testTempDir("agents-harness-builtins");
  try {
    const discovery = await Effect.runPromise(
      discoverHarnesses({ global: join(dir, "none"), workspaces: [], repositories: [] }),
    );
    expect(discovery.harnesses.map((found) => found.key).sort()).toEqual([
      "builtin:opencode",
      "builtin:pi",
      "builtin:pi-bare",
    ]);
    const bare = resolved(discovery, "pi-bare");
    expect(bare.agent).toBe("pi");
    expect(bare.chain.map((link) => link.id)).toEqual(["pi-bare", "pi"]);
    expect(bare.fields.extensions.mode).toBe("none");
    expect(bare.fields.skills.mode).toBe("none");
    expect(bare.fields.packages).toEqual({ include: [], exclude: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a user harness inherits the chain, and its overlay merges on top", () => {
  const discovery = discoveryOf([
    fileOf("review-env", "global", {
      label: "Review environment",
      harness: "pi-bare",
      skills: { exclude: ["spiega"] },
      extensions: { include: ["some-extension"] },
    }),
  ]);
  const found = resolved(discovery, "review-env", overlayOf({ model: "deepseek/flash", effort: "low" }));
  expect(found.agent).toBe("pi");
  expect(found.key).toBe("global:review-env");
  expect(found.chain.map((link) => link.id)).toEqual(["review-env", "pi-bare", "pi"]);
  // The mode is inherited from pi-bare; the user's lists append to it.
  expect(found.fields.skills).toEqual({ mode: "none", include: [], exclude: ["spiega"] });
  expect(found.fields.extensions).toEqual({ mode: "none", include: ["some-extension"], exclude: [] });
  expect(found.fields.model).toBe("deepseek/flash");
  expect(found.fields.effort).toBe("low");
  expect(found.warnings).toEqual([]);
});

test("an opencode harness warns about the fields only pi acts on", () => {
  const discovery = discoveryOf([
    fileOf("oc-env", "global", {
      label: "Open environment",
      harness: "opencode",
      effort: "high",
      skills: { exclude: ["spiega"] },
    }),
  ]);
  const found = resolved(discovery, "oc-env", overlayOf({ model: "some/model" }));
  expect(found.agent).toBe("opencode");
  const fields = found.warnings.map((warning) => (warning.kind === "unsupported-field" ? warning.field : ""));
  expect(fields.sort()).toEqual(["effort", "skills"]);
  expect(found.warnings.every((warning) => warning.kind === "unsupported-field")).toBe(true);
});

test("a chain that cannot run is an error naming it", () => {
  const discovery = discoveryOf([
    fileOf("cycle-a", "global", { label: "A", harness: "cycle-b" }),
    fileOf("cycle-b", "global", { label: "B", harness: "cycle-a" }),
    fileOf("switches", "global", { label: "Switch", harness: "pi", agent: "opencode" }),
    fileOf("rootless", "global", { label: "Rootless" }),
    fileOf("missing-base", "global", { label: "Missing", harness: "nope" }),
  ]);

  const unknown = failureOf(resolveHarness(discovery, "nope"));
  expect(unknown.kind).toBe("unknown-harness");
  expect(describeHarnessError(unknown)).toContain("unknown harness");

  const missing = failureOf(resolveHarness(discovery, "missing-base"));
  expect(missing.kind).toBe("unknown-harness");
  expect(missing.chain).toEqual(["missing-base", "nope"]);

  const cycle = failureOf(resolveHarness(discovery, "cycle-a"));
  expect(cycle.kind).toBe("cycle");
  expect(cycle.chain).toEqual(["cycle-a", "cycle-b", "cycle-a"]);

  const switching = failureOf(resolveHarness(discovery, "switches"));
  expect(switching.kind).toBe("agent-switch");
  if (switching.kind === "agent-switch") expect(switching.agents).toEqual(["opencode", "pi"]);

  // A user file without `harness:` is based on the built-in pi, not refused.
  expect(resolved(discovery, "rootless").chain.map((link) => link.id)).toEqual(["rootless", "pi"]);
  expect(resolved(discovery, "rootless").agent).toBe("pi");

  const noAgent = discoveryOf([
    fileOf("bare-root", "builtin", { label: "No agent" }),
    fileOf("child", "global", { label: "Child", harness: "bare-root" }),
  ]);
  expect(failureOf(resolveHarness(noAgent, "child")).kind).toBe("missing-agent");
});

test("an id several repositories define is ambiguous unless the referrer owns one", () => {
  const files = [
    fileOf("env", "repository", { label: "A env", harness: "pi-bare" }, "a"),
    fileOf("env", "repository", { label: "B env", harness: "pi-bare" }, "b"),
    fileOf("reviewer", "global", { label: "Global", harness: "env" }),
    fileOf("local", "repository", { label: "Local", harness: "env" }, "a"),
  ];
  const discovery = discoveryOf(files);

  const ambiguous = failureOf(resolveHarness(discovery, "reviewer"));
  expect(ambiguous.kind).toBe("ambiguous-harness");
  if (ambiguous.kind === "ambiguous-harness") {
    expect(ambiguous.keys).toEqual(["repository:a:env", "repository:b:env"]);
  }

  const local = resolveHarnessByKey(discovery, "repository:a:local");
  expect(Result.isSuccess(local)).toBe(true);
  if (Result.isSuccess(local)) {
    expect(local.success.chain.map((link) => link.key)).toEqual([
      "repository:a:local",
      "repository:a:env",
      "builtin:pi-bare",
      "builtin:pi",
    ]);
  }
});

test("a repository file shadows a general one; two repositories keep their own", () => {
  const discovery = discoveryOf([
    fileOf("reviewer", "global", { label: "Global", harness: "pi" }),
    fileOf("reviewer", "repository", { label: "Orders", harness: "pi" }, "orders-api"),
    fileOf("reviewer", "repository", { label: "Billing", harness: "pi" }, "billing"),
  ]);
  expect(discovery.harnesses.map((found) => found.key).sort()).toEqual([
    "builtin:opencode",
    "builtin:pi",
    "builtin:pi-bare",
    "repository:billing:reviewer",
    "repository:orders-api:reviewer",
  ]);
});

test("a pinned key that disappeared is an unknown harness, and an unreadable file is skipped", () => {
  const discovery = mergeHarnessFiles([
    ...BUILTINS,
    { id: "broken", source: "global", text: "", readable: false },
  ]);
  const gone = failureOf(resolveHarnessByKey(discovery, "global:gone"));
  expect(gone.kind).toBe("unknown-harness");
  expect(describeHarnessError(gone)).toContain("global:gone");
  expect(discovery.skipped.map((file) => file.key)).toEqual(["global:broken"]);
  expect(discovery.skipped[0]?.reasons.join("; ")).toContain("cannot read");
});

test("a user file cannot replace a built-in harness id", () => {
  const discovery = mergeHarnessFiles([...BUILTINS, fileOf("pi", "global", { label: "Mine", agent: "pi" })]);
  expect(discovery.harnesses.some((found) => found.key === "builtin:pi")).toBe(true);
  expect(discovery.harnesses.some((found) => found.key === "global:pi")).toBe(false);
  expect(discovery.skipped[0]?.reasons.join("; ")).toContain("built-in");
  expect(resolved(discovery, "pi").chain.map((link) => link.key)).toEqual(["builtin:pi"]);
});

test("a chain link carries where it came from", () => {
  const discovery = discoveryOf([fileOf("mine", "workspace", { label: "Mine", harness: "pi" }, "personal")]);
  const found = resolved(discovery, "mine");
  expect(found.chain.map((link) => link.source)).toEqual(["workspace", "builtin"]);
  expect(found.chain[0]?.sourceLabel).toBe("personal");
});
