import { expect, test } from "bun:test";

import type { HarnessSection } from "../src/harnessFields.ts";
import {
  CORVI_EXTENSION_NAME,
  generatedHarnessDir,
  harnessScopeRoot,
  packageNameOf,
  planHarnessEnvironment,
  resolveOverlayPaths,
  type HarnessBase,
  type HarnessGenerationPlan,
} from "../src/harnessGeneration.ts";
import type { ResolvedHarness } from "../src/harnessDiscovery.ts";

const section = (partial: Partial<HarnessSection> = {}): HarnessSection => ({
  include: [],
  exclude: [],
  ...partial,
});

const harnessOf = (overrides: {
  readonly key?: string;
  readonly id?: string;
  readonly source?: ResolvedHarness["source"];
  readonly origin?: string;
  readonly agent?: ResolvedHarness["agent"];
  readonly fields?: Partial<ResolvedHarness["fields"]>;
}): ResolvedHarness => {
  const id = overrides.id ?? "review";
  const source = overrides.source ?? "global";
  const key = overrides.key ?? `${source}:${id}`;
  return {
    key,
    id,
    label: "Review",
    source,
    ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
    agent: overrides.agent ?? "pi",
    fields: {
      extensions: section(),
      skills: section(),
      packages: section(),
      mcp: section(),
      ...overrides.fields,
    },
    chain: [{ key, id, label: "Review", source }],
    warnings: [],
  };
};

const BASE: HarnessBase = {
  paths: {
    agentDir: "/home/u/.pi/agent",
    extensionsDir: "/home/u/.pi/agent/extensions",
    skillsDir: "/home/u/.pi/agent/skills",
    homeDir: "/home/u",
    homeSkillsDir: "/home/u/.agents/skills",
    corviExtension: "/repo/integrations/pi/src",
  },
  present: { extensionsDir: true, skillsDir: true },
  settings: {
    theme: "dark",
    prompts: ["./prompts/review.md", "!./prompts/old.md", "npm:ignored"],
    themes: ["/absolute/theme.json"],
  },
  mcp: { mcpServers: { docs: { url: "https://docs" }, noise: { command: "noise" } } },
  agentsMd: "base rules",
  catalogs: {
    extensions: [
      { name: "footer", path: "/home/u/.pi/agent/extensions/footer/index.ts", location: "extensions" },
      { name: "noisy", path: "/home/u/.pi/agent/extensions/noisy.ts", location: "extensions" },
    ],
    skills: [
      { name: "mine", path: "/home/u/.pi/agent/skills/mine", location: "skills" },
      { name: "spiega", path: "/home/u/.agents/skills/spiega", location: "agents-skills" },
    ],
    packages: [
      { name: "footer-pkg", source: "npm:footer-pkg@1.2.0", entry: "npm:footer-pkg@1.2.0" },
      { name: "tools", source: "./tools", entry: "./tools" },
      {
        name: "@scope/thing",
        source: "npm:@scope/thing@2",
        entry: { source: "npm:@scope/thing@2", extensions: ["x"] },
      },
    ],
    mcp: ["docs", "noise"],
  },
};

const plan = (
  harness: ResolvedHarness,
  overrides: { readonly base?: HarnessBase; readonly scopeBase?: string } = {},
): HarnessGenerationPlan =>
  planHarnessEnvironment({
    harness,
    dir: "/state/harnesses/change/global/review",
    base: overrides.base ?? BASE,
    ...(overrides.scopeBase === undefined ? {} : { scopeBase: overrides.scopeBase }),
  });

const settingsOf = (planned: HarnessGenerationPlan): Record<string, unknown> =>
  JSON.parse(planned.settingsJson) as Record<string, unknown>;

test("mode all inherits the base directories, packages and MCP servers, and adds Corvi", () => {
  const planned = plan(harnessOf({}));
  const settings = settingsOf(planned);
  expect(settings["theme"]).toBe("dark");
  expect(settings["prompts"]).toEqual([
    "/home/u/.pi/agent/prompts/review.md",
    "!/home/u/.pi/agent/prompts/old.md",
    "/home/u/.pi/agent/npm:ignored",
  ]);
  expect(settings["themes"]).toEqual(["/absolute/theme.json"]);
  expect(settings["extensions"]).toEqual(["/home/u/.pi/agent/extensions", "/repo/integrations/pi/src"]);
  expect(settings["skills"]).toEqual(["/home/u/.pi/agent/skills"]);
  expect(settings["packages"]).toEqual([
    "npm:footer-pkg@1.2.0",
    "/home/u/.pi/agent/tools",
    { source: "npm:@scope/thing@2", extensions: ["x"] },
  ]);
  expect(JSON.parse(planned.mcpJson)).toEqual({
    mcpServers: { docs: { url: "https://docs" }, noise: { command: "noise" } },
  });
  expect(planned.agentsMd).toBe("base rules");

  const extensions = planned.view.sections.extensions;
  expect(extensions.mode).toBe("all");
  expect(extensions.items.map((item) => [item.name, item.state, item.origin])).toEqual([
    ["footer", "included", "inherited"],
    ["noisy", "included", "inherited"],
    [CORVI_EXTENSION_NAME, "included", "added-by-corvi"],
  ]);
  expect(extensions.items.at(-1)?.byCorvi).toBe(true);
  expect(planned.view.sections.skills.items.map((item) => item.location)).toEqual([
    "skills",
    "agents-skills",
  ]);
});

test("base settings resource entries are inherited, and builtin entries survive mode none", () => {
  const base: HarnessBase = {
    ...BASE,
    settings: {
      ...BASE.settings,
      extensions: ["-builtin:mcp", "./extra.ts"],
      skills: ["./shared-skill"],
    },
  };
  const all = plan(harnessOf({}), { base });
  expect(settingsOf(all)["extensions"]).toEqual([
    "/home/u/.pi/agent/extra.ts",
    "-builtin:mcp",
    "/home/u/.pi/agent/extensions",
    "/repo/integrations/pi/src",
  ]);
  expect(settingsOf(all)["skills"]).toEqual(["/home/u/.pi/agent/shared-skill", "/home/u/.pi/agent/skills"]);
  expect(all.view.sections.extensions.items.find((item) => item.name === "builtin:mcp")).toMatchObject({
    state: "excluded",
    location: "builtin",
  });

  const none = plan(
    harnessOf({
      fields: { extensions: section({ mode: "none" }), skills: section({ mode: "none" }) },
    }),
    { base },
  );
  // Mode none drops the base paths but never a base builtin: entry.
  expect(settingsOf(none)["extensions"]).toEqual(["-builtin:mcp", "/repo/integrations/pi/src"]);
  expect(settingsOf(none)["skills"]).toEqual(["!/home/u/.agents/skills/*"]);
});

test("mode none lists only what is included, plus Corvi and the included home skill", () => {
  const planned = plan(
    harnessOf({
      fields: {
        extensions: section({ mode: "none" }),
        skills: section({ mode: "none", include: ["spiega"] }),
      },
    }),
  );
  const settings = settingsOf(planned);
  expect(settings["extensions"]).toEqual(["/repo/integrations/pi/src"]);
  expect(settings["skills"]).toEqual(["!/home/u/.agents/skills/*", "+/home/u/.agents/skills/spiega"]);
  const skills = planned.view.sections.skills;
  expect(skills.items.map((item) => [item.name, item.state, item.origin])).toEqual([
    ["mine", "excluded", "excluded"],
    ["spiega", "included", "included"],
  ]);
});

test("excluding a discovered item is shown, and removes it in mode all", () => {
  const planned = plan(
    harnessOf({
      fields: {
        extensions: section({ exclude: ["noisy"] }),
        skills: section({ exclude: ["spiega", "mine"] }),
        mcp: section({ exclude: ["noise"] }),
      },
    }),
  );
  const settings = settingsOf(planned);
  expect(settings["extensions"]).toEqual([
    "/home/u/.pi/agent/extensions",
    "/repo/integrations/pi/src",
    "-/home/u/.pi/agent/extensions/noisy.ts",
  ]);
  expect(settings["skills"]).toEqual([
    "/home/u/.pi/agent/skills",
    "-/home/u/.pi/agent/skills/mine",
    "-/home/u/.agents/skills/spiega",
  ]);
  expect(JSON.parse(planned.mcpJson)).toEqual({ mcpServers: { docs: { url: "https://docs" } } });
  expect(planned.view.sections.extensions.items.find((item) => item.name === "noisy")?.state).toBe(
    "excluded",
  );
  expect(planned.view.sections.skills.items.map((item) => [item.name, item.origin])).toEqual([
    ["mine", "excluded"],
    ["spiega", "excluded"],
  ]);
});

test("built-in extensions pass through as builtin: names, and an exclusion always applies", () => {
  const planned = plan(
    harnessOf({
      fields: {
        extensions: section({
          mode: "none",
          include: ["builtin:llama.cpp", "builtin:mcp"],
          exclude: ["builtin:mcp"],
        }),
      },
    }),
  );
  expect(settingsOf(planned)["extensions"]).toEqual([
    "/repo/integrations/pi/src",
    "+builtin:llama.cpp",
    "-builtin:mcp",
  ]);
  expect(planned.view.warnings).toEqual([]);
  expect(
    planned.view.sections.extensions.items
      .filter((item) => item.location === "builtin")
      .map((item) => [item.name, item.state]),
  ).toEqual([
    ["builtin:llama.cpp", "included"],
    ["builtin:mcp", "excluded"],
  ]);
});

test("a harness can exclude Corvi's extension, and the view says it did", () => {
  const planned = plan(harnessOf({ fields: { extensions: section({ exclude: ["corvi"] }) } }));
  expect(settingsOf(planned)["extensions"]).toEqual(["/home/u/.pi/agent/extensions"]);
  const corvi = planned.view.sections.extensions.items.find((item) => item.byCorvi === true);
  expect(corvi?.state).toBe("excluded");
  expect(corvi?.origin).toBe("excluded");
});

test("an exclusion wins over an include in the same section", () => {
  const planned = plan(
    harnessOf({
      fields: {
        extensions: section({ mode: "none", include: ["footer"], exclude: ["footer"] }),
        skills: section({ mode: "none", include: ["spiega"], exclude: ["spiega"] }),
      },
    }),
  );
  const settings = settingsOf(planned);
  expect(settings["extensions"]).toEqual(["/repo/integrations/pi/src"]);
  expect(settings["skills"]).toEqual(["!/home/u/.agents/skills/*"]);
  expect(planned.view.sections.skills.items.find((item) => item.name === "spiega")?.state).toBe("excluded");
});

test("model, effort, enabledModels and instructions go into the generated files", () => {
  const planned = plan(
    harnessOf({
      fields: {
        model: "mistral/deepseek-v4-1-flash-1017",
        effort: "low",
        enabledModels: ["deepseek/flash", "zai/glm-5.3-flash"],
        instructions: "harness rules\n",
      },
    }),
  );
  const settings = settingsOf(planned);
  expect(settings["defaultProvider"]).toBe("mistral");
  expect(settings["defaultModel"]).toBe("deepseek-v4-1-flash-1017");
  expect(settings["defaultThinkingLevel"]).toBe("low");
  expect(settings["enabledModels"]).toEqual(["deepseek/flash", "zai/glm-5.3-flash"]);
  expect(planned.agentsMd).toBe("harness rules\n");
  expect(planned.view.instructions).toEqual({ origin: "harness", text: "harness rules\n" });
  expect(planned.view.model).toEqual({ provider: "mistral", id: "deepseek-v4-1-flash-1017" });
});

test("instructions: absent inherits the base, empty replaces it with nothing", () => {
  const inherited = plan(harnessOf({ fields: { instructions: undefined } }));
  expect(inherited.view.instructions.origin).toBe("base");
  expect(inherited.agentsMd).toBe("base rules");

  const empty = plan(harnessOf({ fields: { instructions: "" } }));
  expect(empty.view.instructions).toEqual({ origin: "harness", text: "" });
  expect(empty.agentsMd).toBe("");

  const none = plan(harnessOf({ fields: {} }), {
    base: { ...BASE, agentsMd: undefined },
  });
  expect(none.view.instructions.origin).toBe("none");
  expect(none.agentsMd).toBeUndefined();
});

test("packages and MCP: mode none selects by name, unknown names warn", () => {
  const planned = plan(
    harnessOf({
      fields: {
        packages: section({ mode: "none", include: ["@scope/thing"] }),
        mcp: section({ mode: "none", include: ["docs"], exclude: ["gone"] }),
      },
    }),
  );
  expect(settingsOf(planned)["packages"]).toEqual([{ source: "npm:@scope/thing@2", extensions: ["x"] }]);
  expect(JSON.parse(planned.mcpJson)).toEqual({ mcpServers: { docs: { url: "https://docs" } } });
  expect(planned.view.warnings.map((warning) => warning.kind === "unknown-name" && warning.name)).toEqual([
    "gone",
  ]);
});

test("unknown include names warn once per section, and paths resolve against the scope root", () => {
  const planned = plan(
    harnessOf({
      source: "repository",
      origin: "orders",
      key: "repository:orders:review",
      fields: {
        extensions: section({ mode: "none", include: ["ghost", "./extensions/local"] }),
        skills: section({ include: ["missing", "../shared-skills"] }),
      },
    }),
    { scopeBase: "/work/orders" },
  );
  const settings = settingsOf(planned);
  expect(settings["extensions"]).toEqual(["/work/orders/extensions/local", "/repo/integrations/pi/src"]);
  expect(settings["skills"]).toEqual(["/home/u/.pi/agent/skills", "/work/shared-skills"]);
  const unknown = planned.view.warnings.filter((warning) => warning.kind === "unknown-name");
  expect(unknown.map((warning) => [warning.section, warning.name])).toEqual([
    ["extensions", "ghost"],
    ["skills", "missing"],
  ]);
  const file = planned.view.sections.extensions.items.find((item) => item.location === "file");
  expect(file?.path).toBe("/work/orders/extensions/local");
});

test("an unknown name from another section says where it belongs", () => {
  const planned = plan(
    harnessOf({
      fields: {
        extensions: section({ mode: "none", include: ["spiega"] }),
        skills: section({ mode: "none", include: ["ghost"] }),
      },
    }),
  );
  const messages = planned.view.warnings.map((warning) =>
    warning.kind === "unknown-name" ? warning.message : "",
  );
  expect(messages).toContain('"spiega" is a skill, not an extension — list it under skills.include');
  expect(messages).toContain('no skills named "ghost" in the base agent directory or ~/.agents/skills');
});

test("skills include works for a name under ~/.agents/skills in mode none", () => {
  const planned = plan(harnessOf({ fields: { skills: section({ mode: "none", include: ["spiega"] }) } }));
  // The auto-discovered home skills are disabled with the glob, then the included one is re-added.
  expect(settingsOf(planned)["skills"]).toEqual([
    "!/home/u/.agents/skills/*",
    "+/home/u/.agents/skills/spiega",
  ]);
  expect(planned.view.sections.skills.items.find((item) => item.name === "spiega")?.state).toBe("included");
});

test("a relative path with no scope root is a warning, not a guess", () => {
  const planned = plan(
    harnessOf({
      source: "builtin",
      key: "builtin:pi",
      fields: { extensions: section({ mode: "none", include: ["./x"] }) },
    }),
  );
  expect(planned.view.warnings.map((warning) => warning.kind)).toEqual(["unresolved-path"]);
  expect(settingsOf(planned)["extensions"]).toEqual(["/repo/integrations/pi/src"]);
});

test("the generated directory has no colons and cannot escape the state tree", () => {
  const dir = generatedHarnessDir("/state/", "change:1", {
    source: "repository",
    origin: "orders/api",
    id: "../review",
  });
  expect(dir).toBe("/state/harnesses/change-x3a1/repository/orders-x2fapi/-x2e.-x2freview");
  expect(dir).not.toContain(":");
  expect(dir.startsWith("/state/harnesses/")).toBe(true);
  expect(generatedHarnessDir("/state", "c", { source: "builtin", id: "pi" })).toBe(
    "/state/harnesses/c/builtin/pi",
  );
  // Two ids that differ only by punctuation cannot clobber one another.
  expect(generatedHarnessDir("/state", "c", { source: "global", id: "review env" })).not.toBe(
    generatedHarnessDir("/state", "c", { source: "global", id: "review-env" }),
  );
});

test("the scope root follows the harness's own scope", () => {
  const roots = {
    global: "/config",
    workspaces: [{ id: "personal", dir: "/config/workspaces/personal" }],
    repositories: [{ name: "orders", dir: "/work/orders" }],
  };
  expect(harnessScopeRoot({ source: "global", origin: undefined }, roots)).toBe("/config");
  expect(harnessScopeRoot({ source: "workspace", origin: "personal" }, roots)).toBe(
    "/config/workspaces/personal",
  );
  expect(harnessScopeRoot({ source: "repository", origin: "orders" }, roots)).toBe("/work/orders");
  expect(harnessScopeRoot({ source: "builtin", origin: undefined }, roots)).toBeUndefined();
});

test("package path entries resolve relative to the file and are added", () => {
  const planned = plan(
    harnessOf({
      source: "repository",
      origin: "orders",
      key: "repository:orders:review",
      fields: { packages: section({ mode: "none", include: ["./local-pkg"] }) },
    }),
    { scopeBase: "/work/orders" },
  );
  expect(settingsOf(planned)["packages"]).toEqual(["/work/orders/local-pkg"]);
  expect(planned.view.warnings).toEqual([]);
  const item = planned.view.sections.packages.items.find((entry) => entry.location === "file");
  expect(item?.path).toBe("/work/orders/local-pkg");
});

test("a package path that cannot resolve warns, and an exclusion wins over an include", () => {
  const unresolved = plan(harnessOf({ fields: { packages: section({ mode: "none", include: ["./pkg"] }) } }));
  expect(unresolved.view.warnings.map((warning) => warning.kind)).toEqual(["unresolved-path"]);

  const excluded = plan(
    harnessOf({
      source: "repository",
      origin: "orders",
      key: "repository:orders:review",
      fields: {
        packages: section({ mode: "none", include: ["./pkg"], exclude: ["./pkg"] }),
      },
    }),
    { scopeBase: "/work/orders" },
  );
  expect(settingsOf(excluded)["packages"]).toEqual([]);
  expect(excluded.view.warnings).toEqual([]);
});

test("a profile overlay's relative paths resolve against the profile file's scope", () => {
  const overlay = resolveOverlayPaths(
    {
      extensions: { include: ["src/ext.ts"], exclude: [] },
      skills: { include: ["./skills/x"], exclude: [] },
      packages: { include: ["./pkg"], exclude: [] },
      mcp: { include: [], exclude: [] },
    },
    "/work/orders",
    "/home/u",
  );
  expect(overlay.extensions.include).toEqual(["/work/orders/src/ext.ts"]);
  expect(overlay.skills.include).toEqual(["/work/orders/skills/x"]);
  expect(overlay.packages.include).toEqual(["/work/orders/pkg"]);
});

test("package names come from the source, not its version or ref", () => {
  expect(packageNameOf("npm:pi-footer-wessel")).toBe("pi-footer-wessel");
  expect(packageNameOf("npm:pi-footer-wessel@1.2.3")).toBe("pi-footer-wessel");
  expect(packageNameOf("npm:@scope/thing@2")).toBe("@scope/thing");
  expect(packageNameOf("git:github.com/example/pi-tools@v1")).toBe("pi-tools");
  expect(packageNameOf("https://github.com/example/pi-tools")).toBe("pi-tools");
  expect(packageNameOf("./tools")).toBe("tools");
});
