/** A remote Corvi-shaped server for the availability page tests: events, changes, plan, cards,
 * widgets, pages, the extension routes and an optional terminal socket. The tests that point a
 * workspace at another Corvi server all need the same shape; the options are what each one reads. */
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";

export type FakeRemote = {
  readonly port: number;
  readonly server: Server;
  readonly received: string[];
  readonly paths: () => string[];
  readonly connections: () => number;
  readonly close: () => void;
};

export type FakeRemoteOptions = {
  readonly changeId: string;
  readonly title?: string;
  readonly plan?: string;
  /** The remote workspace id the change belongs to. */
  readonly workspace?: string;
  readonly terminal?: boolean;
  /** The state the remote reports for the sidebar icon ("ok", "error", ...). */
  readonly summaryState?: string;
  /** The one card's summary line, so the dashboard's cached value is visible. */
  readonly widgetSummary?: string;
  /** The notes extension: the dashboard lists its widget and its own route serves the text. */
  readonly notes?: boolean;
  /** The leftovers extension's page: the page list offers it and its route serves these names. */
  readonly leftovers?: readonly string[];
};

export const startFakeRemote = async (port: number, options: FakeRemoteOptions): Promise<FakeRemote> => {
  const received: string[] = [];
  const paths: string[] = [];
  let connections = 0;
  const record = (): Record<string, string> => ({
    id: options.changeId,
    branch: options.changeId,
    workspace: options.workspace ?? "client",
    title: options.title ?? "Remote change",
    state: "Implementation",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    paths.push(`${req.method ?? ""} ${path}`);
    const json = (value: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (path.startsWith("/api/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": open\n\n");
      const beat = setInterval(() => res.write(": ping\n\n"), 250);
      res.on("close", () => clearInterval(beat));
      return;
    }
    if (
      options.terminal === true &&
      path.startsWith(`/api/changes/${options.changeId}/terminal`) &&
      !path.includes("/socket")
    ) {
      return json({ url: `/api/changes/${options.changeId}/terminal/socket` });
    }
    if (path.startsWith(`/api/changes/${options.changeId}/plan`))
      return json({ text: options.plan ?? "", revision: "1" });
    if (path === `/api/changes/${options.changeId}/summary`)
      return json({ facts: [], state: options.summaryState ?? "ok" });
    if (path === `/api/changes/${options.changeId}/cards`)
      return json([{ name: "demo", title: "Demo", perRepo: false, column: "left" }]);
    if (path.startsWith(`/api/changes/${options.changeId}/cards/demo`))
      return json({
        integration: "demo",
        title: "Demo",
        state: "ok",
        summary: "",
        items: [{ label: options.widgetSummary ?? "WIDGET", state: "ok" }],
      });
    if (path === `/api/changes/${options.changeId}/widgets`)
      return json({
        widgets:
          options.notes === true ? [{ id: "notes", title: "Notes", extension: "notes", column: "left" }] : [],
      });
    if (path.includes("/ext/notes/")) return json({ text: "NOTES" });
    if (path === `/api/changes/${options.changeId}/tabs`) return json({ tabs: [] });
    if (path === `/api/changes/${options.changeId}`) return json(record());
    if (path === "/api/changes") return json([record()]);
    if (path.startsWith("/api/workspaces")) return json({ workspaces: [] });
    if (path.startsWith("/api/pages"))
      return json({
        pages:
          options.leftovers === undefined
            ? []
            : [{ id: "leftovers", title: "Leftovers", extension: "leftovers" }],
      });
    if (path.includes("/ext/leftovers/list"))
      return json(
        (options.leftovers ?? []).map((name) => ({
          name,
          path: `/tmp/${name}`,
          entries: [],
          kilobytes: 1,
        })),
      );
    if (path.startsWith("/api/terminals")) return json({});
    if (path.startsWith("/api/dashboard/")) return json([]);
    if (path.startsWith("/api/wizard")) return json({ steps: [], planTemplate: "" });
    json({});
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    connections += 1;
    socket.on("message", (data, isBinary) => {
      received.push(isBinary ? new TextDecoder().decode(data as Buffer) : data.toString());
    });
    // The pane is "attached" once a control frame names its session.
    socket.send(JSON.stringify({ type: "reset", sessionId: "w-1" }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  return {
    port,
    server,
    received,
    paths: () => paths,
    connections: () => connections,
    close: () => {
      wss.close();
      server.closeAllConnections?.();
      server.close();
    },
  };
};
