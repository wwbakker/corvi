import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { loaded } from "../apps/server/src/integrations/index.ts";
import { MASK } from "../apps/server/src/settings/server/secrets.ts";
import { problems, settingsViewSync, writeSettings } from "../apps/server/src/settings/server/index.ts";
import {
  configPath,
  reloadConfigSync,
  runtimeConfig,
  workspaceViews,
} from "../apps/server/src/workspace/server/index.ts";
import { workspaceRoutes } from "../apps/server/src/workspace/routes.ts";
import { runEffect } from "./helpers.ts";

/**
 * A workspace can be remote: a normal config entry whose target and device token live beside the
 * local ones. The token and any declared extension secret are credentials — they must never reach
 * the page — while the remote shape must round-trip the file and survive a hand-mangled neighbour.
 */

const writeConfig = async (value: unknown): Promise<void> => {
  await Bun.write(configPath(), JSON.stringify(value));
  reloadConfigSync();
};

const remote = { url: "https://host.tailnet.ts.net", workspace: "client", token: "device-token" };

const workspacesRoute = (): Promise<Response> => {
  const routes = workspaceRoutes as unknown as Record<string, { GET: (req: Request) => Response }>;
  return Promise.resolve(
    routes["/api/workspaces"]!.GET!(
      new Request("http://127.0.0.1:4000/api/workspaces", {
        headers: { "sec-fetch-site": "same-origin" },
      }),
    ),
  );
};

test("a remote workspace round-trips through the config", async () => {
  await writeConfig({ workspaces: [{ id: "remote-client", name: "Client", remote }] });
  expect(runtimeConfig().workspaces).toEqual([{ id: "remote-client", name: "Client", remote }]);

  const written = JSON.parse(await readFile(configPath(), "utf8")) as {
    workspaces: { remote?: unknown }[];
  };
  expect(written.workspaces[0]?.remote).toEqual(remote);
});

test("a malformed remote entry is tolerated per item", async () => {
  await writeConfig({
    workspaces: [
      // No url, so the remote is malformed; the workspace entry itself is still the user's.
      { id: "bad-remote", name: "Bad", remote: { workspace: 7 } },
      { id: "good", name: "Good", remote },
      { id: "local", name: "Local" },
    ],
  });

  const workspaces = runtimeConfig().workspaces;
  // The file is not emptied and every context survives.
  expect(workspaces.map((workspace) => workspace.id)).toEqual(["bad-remote", "good", "local"]);
  // Only the malformed nested remote is dropped.
  expect(workspaces.find((workspace) => workspace.id === "bad-remote")?.remote).toBeUndefined();
  expect(workspaces.find((workspace) => workspace.id === "good")?.remote).toEqual(remote);
  expect(workspaces.find((workspace) => workspace.id === "local")?.remote).toBeUndefined();
});

test("the settings view masks the remote token in file and effective", async () => {
  await writeConfig({ workspaces: [{ id: "remote-client", name: "Client", remote }] });
  const view = settingsViewSync();

  expect(view.file.workspaces?.[0]?.remote?.token).toBe(MASK);
  expect(view.effective.workspaces[0]?.remote?.token).toBe(MASK);
  expect(JSON.stringify(view)).not.toContain(remote.token);
  // The redaction copies: the config a request is reading still holds the real token.
  expect(runtimeConfig().workspaces[0]?.remote?.token).toBe(remote.token);
});

test("a save that sends the mask back keeps the stored token", async () => {
  await writeConfig({ workspaces: [{ id: "remote-client", name: "Client", remote }] });
  const view = settingsViewSync();

  // The page edits something else and hands the masked workspaces back unchanged.
  await runEffect(writeSettings({ ...view.file, workspaces: view.file.workspaces }));
  expect(runtimeConfig().workspaces[0]?.remote?.token).toBe(remote.token);

  const written = await readFile(configPath(), "utf8");
  expect(JSON.parse(written)).toMatchObject({
    workspaces: [{ id: "remote-client", remote: { token: remote.token } }],
  });
  expect(written).not.toContain(MASK);
});

test("a remote sent without a token keeps the stored token", async () => {
  await writeConfig({ workspaces: [{ id: "remote-client", name: "Client", remote }] });
  // A form that cannot display the token builds `remote` from its visible fields only.
  await runEffect(
    writeSettings({
      workspaces: [
        { id: "remote-client", name: "Client", remote: { url: remote.url, workspace: remote.workspace } },
      ],
    }),
  );
  expect(runtimeConfig().workspaces[0]?.remote?.token).toBe(remote.token);
});

test("a changed url drops the stored token rather than carrying it to a new host", async () => {
  await writeConfig({ workspaces: [{ id: "remote-client", name: "Client", remote }] });
  // The editor's address field edits only the url; the token field still holds the mask. The old
  // host's credential must not be restored for the new host.
  await runEffect(
    writeSettings({
      workspaces: [
        {
          id: "remote-client",
          name: "Client",
          remote: { url: "https://other.tailnet.ts.net", workspace: remote.workspace, token: MASK },
        },
      ],
    }),
  );
  expect(runtimeConfig().workspaces[0]?.remote?.token).toBeUndefined();
  const written = JSON.parse(await readFile(configPath(), "utf8")) as {
    workspaces: { remote?: { token?: string } }[];
  };
  expect(written.workspaces[0]?.remote?.token).toBeUndefined();
});

test("a changed remote workspace id drops the stored token", async () => {
  await writeConfig({ workspaces: [{ id: "remote-client", name: "Client", remote }] });
  await runEffect(
    writeSettings({
      workspaces: [
        {
          id: "remote-client",
          name: "Client",
          remote: { url: remote.url, workspace: "another", token: MASK },
        },
      ],
    }),
  );
  expect(runtimeConfig().workspaces[0]?.remote?.token).toBeUndefined();
});

test("an empty token clears the stored one", async () => {
  await writeConfig({ workspaces: [{ id: "remote-client", name: "Client", remote }] });
  await runEffect(
    writeSettings({
      workspaces: [
        {
          id: "remote-client",
          name: "Client",
          remote: { url: remote.url, workspace: remote.workspace, token: "" },
        },
      ],
    }),
  );
  expect(runtimeConfig().workspaces[0]?.remote?.token).toBeUndefined();
  const written = JSON.parse(await readFile(configPath(), "utf8")) as {
    workspaces: { remote?: { token?: string } }[];
  };
  expect(written.workspaces[0]?.remote?.token).toBeUndefined();
});

test("a new token replaces the stored one", async () => {
  await writeConfig({ workspaces: [{ id: "remote-client", name: "Client", remote }] });
  await runEffect(
    writeSettings({
      workspaces: [
        {
          id: "remote-client",
          name: "Client",
          remote: { url: remote.url, workspace: remote.workspace, token: "new-token" },
        },
      ],
    }),
  );
  expect(runtimeConfig().workspaces[0]?.remote?.token).toBe("new-token");
});

test("a mask for a token nothing is stored in is dropped, not persisted", async () => {
  await writeConfig({
    workspaces: [{ id: "remote-client", name: "Client", remote: { url: remote.url, workspace: remote.workspace } }],
  });
  await runEffect(
    writeSettings({
      workspaces: [
        {
          id: "remote-client",
          name: "Client",
          remote: { url: remote.url, workspace: remote.workspace, token: MASK },
        },
      ],
    }),
  );
  expect(runtimeConfig().workspaces[0]?.remote?.token).toBeUndefined();
  expect(await readFile(configPath(), "utf8")).not.toContain(MASK);
});

test("a save with workspaces absent preserves the stored workspaces", async () => {
  await writeConfig({ workspaces: [{ id: "remote-client", name: "Client", remote }] });
  await runEffect(writeSettings({ notificationSound: false }));

  expect(runtimeConfig().notificationSound).toBe(false);
  expect(runtimeConfig().workspaces).toEqual([{ id: "remote-client", name: "Client", remote }]);
});

test("the workspaces route masks the remote token and extension secrets", async () => {
  await writeConfig({
    workspaces: [
      { id: "remote-client", name: "Client", remote },
      {
        id: "jira-client",
        name: "Jira",
        settings: { extensionSettings: { jira: { token: "workspace-jira-secret" } } },
      },
    ],
  });

  const body = (await (await workspacesRoute()).json()) as {
    workspaces: {
      remote?: { token?: string };
      settings?: { extensionSettings?: { jira?: { token?: string } } };
    }[];
  };
  const text = JSON.stringify(body);
  expect(text).not.toContain(remote.token);
  expect(text).not.toContain("workspace-jira-secret");
  expect(body.workspaces[0]?.remote?.token).toBe(MASK);
  expect(body.workspaces[1]?.settings?.extensionSettings?.["jira"]?.["token"]).toBe(MASK);

  // The helper the route uses masks both too.
  const views = workspaceViews(loaded);
  expect(views[0]?.remote?.token).toBe(MASK);
  expect(views[1]?.settings?.extensionSettings?.["jira"]?.["token"]).toBe(MASK);
});

test("the workspace view is not aliased to the live config", async () => {
  await writeConfig({
    workspaces: [{ id: "w", name: "W", settings: { changesRoot: "/tmp/original" }, remote }],
  });

  const view = workspaceViews(loaded)[0]!;
  (view as { name: string }).name = "mutated";
  (view.settings as { changesRoot?: string }).changesRoot = "/tmp/mutated";
  (view.remote as { token?: string }).token = "mutated";

  expect(runtimeConfig().workspaces[0]?.name).toBe("W");
  expect(runtimeConfig().workspaces[0]?.settings?.changesRoot).toBe("/tmp/original");
  expect(runtimeConfig().workspaces[0]?.remote?.token).toBe(remote.token);
});

test("validation refuses a malformed remote workspace", () => {
  expect(
    problems({ workspaces: [{ id: "r", name: "R", remote: { url: "ftp://host", workspace: "w" } }] }),
  ).toEqual(["R: the remote url must be http or https"]);

  expect(
    problems({
      workspaces: [{ id: "r", name: "R", remote: { url: "https://host", workspace: "not a word" } }],
    }),
  ).toEqual(["R: the remote workspace id must be a word"]);

  // A remote workspace's settings live on the host: carrying both is refused, not ignored.
  expect(
    problems({
      workspaces: [
        {
          id: "r",
          name: "R",
          remote: { url: "https://host", workspace: "w" },
          settings: { notificationSound: false },
        },
      ],
    }),
  ).toEqual(["R is remote: it cannot also carry settings"]);

  // A local and a remote entry cannot share this client's id.
  expect(
    problems({
      workspaces: [
        { id: "same", name: "Local" },
        { id: "same", name: "Remote", remote: { url: "https://host", workspace: "w" } },
      ],
    }),
  ).toEqual(['two workspaces share the id "same"']);

  // A non-object `remote` is a validation message, never a throw out of the route.
  const badRemote = (value: unknown): string[] =>
    problems({ workspaces: [{ id: "r", name: "R", remote: value } as never] });
  expect(badRemote(null)).toEqual(["R: remote must be an object with a url and a workspace"]);
  expect(badRemote("nope")).toEqual(["R: remote must be an object with a url and a workspace"]);
});
