import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result } from "effect";

import { testTempDir } from "@corvi/test-support/temp";
import {
  describeHarnessProfileError,
  resolveHarnessProfileByKey,
  type HarnessProfileDiscovery,
  type ResolvedHarnessProfile,
} from "../src/harnessProfileDiscovery.ts";
import {
  baseAgentDir,
  corviExtensionDir,
  discoverHarnessProfiles,
  generateEnvironment,
  previewEnvironment,
  type GenerateEnvironmentOptions,
} from "../src/node/index.ts";

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

type Fixture = {
  readonly tmp: string;
  readonly agentDir: string;
  readonly homeDir: string;
  readonly configDir: string;
  readonly harnessDir: string;
  readonly corviExtension: string;
  readonly stateDir: string;
};

const fixture = async (label: string): Promise<Fixture> => {
  const tmp = await testTempDir(label);
  const agentDir = join(tmp, "agent");
  const homeDir = join(tmp, "home");
  const configDir = join(tmp, "config");
  const harnessDir = join(configDir, "harnesses");
  const corviExtension = join(tmp, "corvi");
  const stateDir = join(tmp, "state");
  await mkdir(join(agentDir, "extensions", "footer"), { recursive: true });
  await mkdir(join(agentDir, "skills", "mine"), { recursive: true });
  await mkdir(join(agentDir, "themes"), { recursive: true });
  await mkdir(join(agentDir, "prompts"), { recursive: true });
  await mkdir(join(agentDir, "bin"), { recursive: true });
  await mkdir(join(homeDir, ".agents", "skills", "spiega"), { recursive: true });
  await mkdir(harnessDir, { recursive: true });
  await mkdir(corviExtension, { recursive: true });
  await writeFile(join(agentDir, "extensions", "footer", "index.ts"), "export {};\n", "utf8");
  await writeFile(join(agentDir, "skills", "mine", "SKILL.md"), "# mine\n", "utf8");
  await writeFile(join(homeDir, ".agents", "skills", "spiega", "SKILL.md"), "# spiega\n", "utf8");
  await writeFile(join(corviExtension, "index.ts"), "export {};\n", "utf8");
  await writeJson(join(agentDir, "settings.json"), {
    theme: "dark",
    packages: ["npm:footer-pkg@1.0.0", "./tools"],
  });
  await writeJson(join(agentDir, "mcp.json"), {
    mcpServers: { docs: { url: "https://docs" }, noise: { command: "noise" } },
  });
  await writeFile(join(agentDir, "AGENTS.md"), "base rules\n", "utf8");
  await writeFile(join(agentDir, "auth.json"), "{}\n", "utf8");
  await writeFile(join(agentDir, "AGENTS.override.md"), "base override\n", "utf8");
  await writeFile(join(agentDir, "keybindings.json"), "{}\n", "utf8");
  await writeFile(join(agentDir, "SYSTEM.md"), "system\n", "utf8");
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "append\n", "utf8");
  await writeFile(join(agentDir, "models.json"), "{}\n", "utf8");
  await writeFile(join(agentDir, "themes", "omarchy-system.json"), "{}\n", "utf8");
  return { tmp, agentDir, homeDir, configDir, harnessDir, corviExtension, stateDir };
};

const writeHarness = (f: Fixture, text: string, id = "review"): Promise<void> =>
  writeFile(join(f.harnessDir, `${id}.md`), text, "utf8");

const discover = (f: Fixture): Promise<HarnessProfileDiscovery> =>
  Effect.runPromise(discoverHarnessProfiles({ global: f.harnessDir, workspaces: [], repositories: [] }));

const resolve = async (f: Fixture, key: string): Promise<ResolvedHarnessProfile> => {
  const discovery = await discover(f);
  const resolved = resolveHarnessProfileByKey(discovery, key);
  if (Result.isFailure(resolved)) throw new Error(describeHarnessProfileError(resolved.failure));
  return resolved.success;
};

const optionsFor = (f: Fixture, harness: ResolvedHarnessProfile): GenerateEnvironmentOptions => ({
  stateDir: f.stateDir,
  changeId: "change-1",
  harnessProfile: harness,
  agentDir: f.agentDir,
  homeDir: f.homeDir,
  corviExtension: f.corviExtension,
  scopeBase: f.configDir,
});

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

const cleanup = (f: Fixture): Promise<void> => rm(f.tmp, { recursive: true, force: true });

test("the defaults are the server's agent directory and this checkout's extension", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/agent-dir";
  try {
    expect(baseAgentDir()).toBe("/tmp/agent-dir");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  expect(corviExtensionDir().endsWith("/integrations/pi/src")).toBe(true);
  expect((await lstat(join(corviExtensionDir(), "index.ts"))).isFile()).toBe(true);
});

test("a generated agent directory carries merged settings, MCP, AGENTS.md and shared state", async () => {
  const f = await fixture("agents-generation");
  try {
    await writeHarness(
      f,
      [
        "---",
        "label: Review",
        "basedOnHarnessProfile: pi-bare",
        "model: mistral/deepseek-v4-1-flash-1017",
        "effort: low",
        "enabledModels: [deepseek/flash]",
        "skills: { mode: none, include: [spiega] }",
        "mcp: { exclude: [noise] }",
        "---",
        "notes",
      ].join("\n"),
    );
    const harness = await resolve(f, "global:review");
    const generated = await Effect.runPromise(generateEnvironment(optionsFor(f, harness)));
    expect(generated.dir).toBe(join(f.stateDir, "harnesses", "change-1", "global", "review"));
    const settings = await readJson(join(generated.dir, "settings.json"));
    expect(settings).toEqual({
      theme: "dark",
      packages: ["npm:footer-pkg@1.0.0", join(f.agentDir, "tools")],
      defaultProvider: "mistral",
      defaultModel: "deepseek-v4-1-flash-1017",
      defaultThinkingLevel: "low",
      enabledModels: ["deepseek/flash"],
      extensions: [f.corviExtension],
      skills: [
        `!${join(f.homeDir, ".agents", "skills")}/*`,
        `+${join(f.homeDir, ".agents", "skills", "spiega")}`,
      ],
    });
    expect(await readJson(join(generated.dir, "mcp.json"))).toEqual({
      mcpServers: { docs: { url: "https://docs" } },
    });
    expect(await readFile(join(generated.dir, "AGENTS.md"), "utf8")).toBe("base rules\n");

    const auth = await lstat(join(generated.dir, "auth.json"));
    expect(auth.isSymbolicLink()).toBe(true);
    expect(await readFile(join(generated.dir, "auth.json"), "utf8")).toBe("{}\n");
    const sessions = await lstat(join(generated.dir, "sessions"));
    expect(sessions.isSymbolicLink()).toBe(true);
    expect((await lstat(join(f.agentDir, "sessions"))).isDirectory()).toBe(true);

    // Everything that is user configuration travels with the harness, including the theme
    // directory and the base override that applies while the harness sets no instructions.
    for (const name of [
      "keybindings.json",
      "SYSTEM.md",
      "APPEND_SYSTEM.md",
      "models.json",
      "AGENTS.override.md",
    ]) {
      expect((await lstat(join(generated.dir, name))).isSymbolicLink()).toBe(true);
    }
    for (const name of ["themes", "prompts", "bin"]) {
      expect((await lstat(join(generated.dir, name))).isSymbolicLink()).toBe(true);
      expect((await lstat(join(f.agentDir, name))).isDirectory()).toBe(true);
    }
    expect(await readFile(join(generated.dir, "themes", "omarchy-system.json"), "utf8")).toBe("{}\n");

    expect(generated.view.sections.extensions.items.at(-1)?.byCorvi).toBe(true);
    expect(generated.view.sections.skills.items.map((item) => [item.name, item.state])).toEqual([
      ["mine", "excluded"],
      ["spiega", "included"],
    ]);
    expect(generated.view.sections.mcp.items.map((item) => [item.name, item.state])).toEqual([
      ["docs", "included"],
      ["noise", "excluded"],
    ]);
    expect(generated.view.chain.map((link) => link.id)).toEqual(["review", "pi-bare", "pi"]);
  } finally {
    await cleanup(f);
  }
});

test("previewing a harness returns the same view without writing the directory", async () => {
  const f = await fixture("agents-preview");
  try {
    await writeHarness(f, "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\n---\n");
    const harness = await resolve(f, "global:review");
    const options = optionsFor(f, harness);
    const preview = await Effect.runPromise(previewEnvironment(options));
    const generated = await Effect.runPromise(generateEnvironment(options));
    expect(preview.dir).toBe(generated.dir);
    expect(preview.view).toEqual(generated.view);
    expect(preview.plan.settingsJson).toBe(await readFile(join(generated.dir, "settings.json"), "utf8"));
  } finally {
    await cleanup(f);
  }
});

test("editing the harness profile file regenerates the same directory", async () => {
  const f = await fixture("agents-regenerate");
  try {
    await writeHarness(
      f,
      "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\nskills: { mode: none, include: [spiega] }\n---\n",
    );
    const first = await resolve(f, "global:review");
    const firstGenerated = await Effect.runPromise(generateEnvironment(optionsFor(f, first)));
    expect((await readJson(join(firstGenerated.dir, "settings.json")))["skills"]).toEqual([
      `!${join(f.homeDir, ".agents", "skills")}/*`,
      `+${join(f.homeDir, ".agents", "skills", "spiega")}`,
    ]);

    await writeHarness(
      f,
      "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\nskills: { mode: none, include: [mine] }\n---\n",
    );
    const second = await resolve(f, "global:review");
    const secondGenerated = await Effect.runPromise(generateEnvironment(optionsFor(f, second)));
    expect(secondGenerated.dir).toBe(firstGenerated.dir);
    expect((await readJson(join(secondGenerated.dir, "settings.json")))["skills"]).toEqual([
      `!${join(f.homeDir, ".agents", "skills")}/*`,
      join(f.agentDir, "skills", "mine"),
    ]);
  } finally {
    await cleanup(f);
  }
});

test("a harness that sets instructions does not inherit the base AGENTS.override.md", async () => {
  const f = await fixture("agents-override");
  try {
    await writeHarness(f, "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\n---\n");
    const withoutInstructions = await resolve(f, "global:review");
    const first = await Effect.runPromise(generateEnvironment(optionsFor(f, withoutInstructions)));
    expect((await lstat(join(first.dir, "AGENTS.override.md"))).isSymbolicLink()).toBe(true);

    await writeHarness(f, "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\ninstructions: mine\n---\n");
    const withInstructions = await resolve(f, "global:review");
    const second = await Effect.runPromise(generateEnvironment(optionsFor(f, withInstructions)));
    expect(second.dir).toBe(first.dir);
    expect(await lstat(join(second.dir, "AGENTS.override.md")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(second.dir, "AGENTS.md"), "utf8")).toBe("mine");
  } finally {
    await cleanup(f);
  }
});

test("a stale AGENTS.md is removed when the harness and the base have none", async () => {
  const f = await fixture("agents-agents-md");
  try {
    await rm(join(f.agentDir, "AGENTS.md"), { force: true });
    await writeHarness(f, "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\ninstructions: notes\n---\n");
    const first = await resolve(f, "global:review");
    const firstGenerated = await Effect.runPromise(generateEnvironment(optionsFor(f, first)));
    expect(await readFile(join(firstGenerated.dir, "AGENTS.md"), "utf8")).toBe("notes");

    await writeHarness(f, "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\n---\n");
    const second = await resolve(f, "global:review");
    const secondGenerated = await Effect.runPromise(generateEnvironment(optionsFor(f, second)));
    expect(secondGenerated.view.instructions.origin).toBe("none");
    expect(await lstat(join(secondGenerated.dir, "AGENTS.md")).catch(() => undefined)).toBeUndefined();
  } finally {
    await cleanup(f);
  }
});

test("regeneration replaces a real sessions directory with the shared link", async () => {
  const f = await fixture("agents-sessions");
  try {
    await writeHarness(f, "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\n---\n");
    const harness = await resolve(f, "global:review");
    const generated = await Effect.runPromise(generateEnvironment(optionsFor(f, harness)));
    const link = join(generated.dir, "sessions");
    await rm(link, { recursive: true, force: true });
    await mkdir(link, { recursive: true });
    await writeFile(join(link, "stale.txt"), "stale", "utf8");

    await Effect.runPromise(generateEnvironment(optionsFor(f, harness)));
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const target = join(f.agentDir, "sessions");
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect(await readFile(join(link, "stale.txt"), "utf8").catch(() => "gone")).toBe("gone");
  } finally {
    await cleanup(f);
  }
});

test("concurrent regenerations never leave a settings file a reader cannot parse", async () => {
  const f = await fixture("agents-concurrent");
  try {
    await writeHarness(f, "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\n---\n");
    const harness = await resolve(f, "global:review");
    const options = optionsFor(f, harness);
    const first = await Effect.runPromise(generateEnvironment(options));
    const settingsPath = join(first.dir, "settings.json");

    const errors: unknown[] = [];
    const writes = Array.from({ length: 12 }, () =>
      Effect.runPromise(generateEnvironment(options)).catch((error: unknown) => {
        errors.push(error);
      }),
    );
    const reads = (async (): Promise<void> => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        try {
          JSON.parse(await readFile(settingsPath, "utf8"));
        } catch (error) {
          errors.push(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    await Promise.all([...writes, reads]);
    expect(errors).toEqual([]);
  } finally {
    await cleanup(f);
  }
});

test("optional base files are linked only when the base has them", async () => {
  const f = await fixture("agents-optional");
  try {
    // A bare agent directory: no keybindings, SYSTEM.md, prompts, themes or override.
    await rm(join(f.agentDir, "keybindings.json"), { force: true });
    await rm(join(f.agentDir, "SYSTEM.md"), { force: true });
    await rm(join(f.agentDir, "APPEND_SYSTEM.md"), { force: true });
    await rm(join(f.agentDir, "AGENTS.override.md"), { force: true });
    await rm(join(f.agentDir, "themes"), { recursive: true, force: true });
    await rm(join(f.agentDir, "prompts"), { recursive: true, force: true });
    await rm(join(f.agentDir, "bin"), { recursive: true, force: true });
    await rm(join(f.agentDir, "auth.json"), { force: true });

    await writeHarness(f, "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\n---\n");
    const harness = await resolve(f, "global:review");
    const generated = await Effect.runPromise(generateEnvironment(optionsFor(f, harness)));
    for (const name of [
      "keybindings.json",
      "SYSTEM.md",
      "APPEND_SYSTEM.md",
      "AGENTS.override.md",
      "auth.json",
    ]) {
      expect(await lstat(join(generated.dir, name)).catch(() => undefined)).toBeUndefined();
    }
    // auth.json and the shared dirs are still created/linked, so credentials keep working.
    expect((await lstat(join(generated.dir, "sessions"))).isSymbolicLink()).toBe(true);
  } finally {
    await cleanup(f);
  }
});

test("a malformed base settings file is a read failure, not an empty environment", async () => {
  const f = await fixture("agents-bad-base");
  try {
    await writeFile(join(f.agentDir, "settings.json"), "{", "utf8");
    await writeHarness(f, "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\n---\n");
    const harness = await resolve(f, "global:review");
    const result = await Effect.runPromise(generateEnvironment(optionsFor(f, harness)).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.operation).toBe("read");
      expect(result.failure.path).toContain("settings.json");
    }
  } finally {
    await cleanup(f);
  }
});

test("opencode harnesses generate nothing", async () => {
  const f = await fixture("agents-opencode");
  try {
    const harness = await resolve(f, "builtin:opencode");
    const result = await Effect.runPromise(generateEnvironment(optionsFor(f, harness)).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.operation).toBe("unsupported-harness");
      expect(result.failure.harness).toBe("opencode");
    }
    expect(await lstat(join(f.stateDir, "harnesses")).catch(() => undefined)).toBeUndefined();
  } finally {
    await cleanup(f);
  }
});

test("a symlinked skill in the base directory is still discovered", async () => {
  const f = await fixture("agents-symlink-skill");
  try {
    const real = join(f.tmp, "real-skill");
    await mkdir(real, { recursive: true });
    await writeFile(join(real, "SKILL.md"), "# real\n", "utf8");
    await symlink(real, join(f.agentDir, "skills", "linked"));
    await writeHarness(
      f,
      "---\nlabel: Review\nbasedOnHarnessProfile: pi-bare\nskills: { include: [linked] }\n---\n",
    );
    const harness = await resolve(f, "global:review");
    const generated = await Effect.runPromise(generateEnvironment(optionsFor(f, harness)));
    expect((await readJson(join(generated.dir, "settings.json")))["skills"]).toContain(
      join(f.agentDir, "skills", "linked"),
    );
    expect(generated.view.sections.skills.items.find((item) => item.name === "linked")?.state).toBe(
      "included",
    );
  } finally {
    await cleanup(f);
  }
});
