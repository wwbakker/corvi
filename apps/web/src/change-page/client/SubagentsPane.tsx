/**
 * The change's subagents: the list, the conversation, and the terminal of whichever one is
 * selected — the observable, controllable face of a subagent instance.
 *
 * The server owns the conversation (one directory per subagent); this pane reads it with
 * `client.subagents` and re-reads on the event bus. The composer appends a logged, submitted
 * message; **Continue** restarts an interrupted turn explicitly. Typing straight into the harness
 * TUI is still possible and is honestly just the terminal: it lives in the harness's own history,
 * not this log.
 */
import { type JSX, useCallback, useEffect, useState } from "react";

import { ChangeId } from "@corvi/contracts/changes";
import type { SubagentInstanceDto, SubagentMessageDto, SubagentSystemEventDto } from "@corvi/contracts/subagents";
import type { Platform } from "@corvi/terminals/model";
import { apiClient } from "../../app-root/api.ts";
import { useServerEvent } from "../../app-root/events.ts";
import { TerminalPane } from "../../terminals/client/TerminalPane.tsx";

/** What a created subagent got when the machine interrupted it mid-task. */
const CONTINUE_NOTE = "The machine was interrupted mid-task. Continue. If you were waiting for information, say so.";

const clock = (at: string): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const stateOf = (instance: SubagentInstanceDto): string =>
  instance.interrupted ? "interrupted" : `${instance.presence}/${instance.activity}`;

function Message({ message }: { message: SubagentMessageDto }): JSX.Element {
  return (
    <p className={`subagent-message ${message.role}`}>
      <span className="summary">
        {message.role} · {clock(message.at)}
      </span>
      <br />
      {message.body}
    </p>
  );
}

function Event({ event }: { event: SubagentSystemEventDto }): JSX.Element {
  return (
    <p className="subagent-event summary">
      {event.kind} · {clock(event.at)}
      {event.note === undefined ? "" : ` · ${event.note}`}
    </p>
  );
}

export function SubagentsPane({
  changeId,
  platform,
  terminal,
  windowsCount,
  onSelectWindow,
}: {
  changeId: string;
  platform: Platform;
  terminal: { url: string | null; error: string | null; create: () => void };
  windowsCount: number;
  /** Switch the shared session to the selected subagent's window. */
  onSelectWindow: (index: number) => void;
}): JSX.Element {
  const [instances, setInstances] = useState<SubagentInstanceDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((): void => {
    apiClient
      .subagents(ChangeId.make(changeId))
      .then(setInstances)
      .catch((e: Error) => setNotice(e.message));
  }, [changeId]);

  useEffect(load, [load]);
  useServerEvent("changes", load);
  useServerEvent("windows", load);

  const current = instances.find((instance) => instance.id === selected) ?? instances[0];

  // Focusing the terminal on the selected subagent's window is the point of putting the two side
  // by side. `windows` re-reads select the same window server-side.
  useEffect(() => {
    if (current?.presence === "attached" && current.windowIndex !== undefined) {
      onSelectWindow(current.windowIndex);
    }
  }, [current?.id, current?.presence, current?.windowIndex, onSelectWindow]);

  const act = async (work: () => Promise<unknown>, message: string): Promise<void> => {
    setNotice(null);
    try {
      await work();
      setNotice(message);
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  const send = (text: string): void => {
    if (!current || text.trim() === "") return;
    void act(
      () => apiClient.sendSubagent(ChangeId.make(changeId), current.id, { text }),
      `sent to ${current.id}`,
    );
    setDraft("");
  };

  if (instances.length === 0) {
    return (
      <div className="page subagents-pane">
        <header>
          <h2>Subagents</h2>
        </header>
        <p className="hint">
          no subagents yet — create one from the command line (`corvi subagent create &lt;profile&gt;`)
          or the Actions menu.
        </p>
      </div>
    );
  }

  return (
    <div className="subagents-layout">
      <div className="terminal-host subagent-terminal">
        <TerminalPane
          changeId={changeId}
          url={terminal.url}
          error={terminal.error}
          visible
          platform={platform}
          onNewWindow={terminal.create}
          windows={windowsCount}
        />
      </div>
      <div className="subagents-conversation">
        <header>
          <h2>Subagents</h2>
          <span className="spacer" />
          {notice && <span className="summary">{notice}</span>}
        </header>
        <div className="subagent-list">
          {instances.map((instance) => (
            <button
              key={instance.id}
              className={`entry${instance.id === current?.id ? " current" : ""}`}
              onClick={() => setSelected(instance.id)}
            >
              {instance.label} <span className="summary">{stateOf(instance)}</span>
              {instance.awaitingReply && <span className="badge ok">reply</span>}
            </button>
          ))}
        </div>
        {current && (
          <>
            <div className="subagent-actions">
              <span className="summary">
                {current.id} · {current.harness}
                {current.model === undefined ? "" : ` · ${current.model}`}
              </span>
              <span className="spacer" />
              {current.interrupted && (
                <button className="create" onClick={() => send(CONTINUE_NOTE)}>
                  Continue
                </button>
              )}
              {current.presence === "attached" ? (
                <button onClick={() => void act(() => apiClient.closeSubagent(ChangeId.make(changeId), current.id), `closed ${current.id}`)}>
                  Close
                </button>
              ) : (
                <button onClick={() => void act(() => apiClient.openSubagent(ChangeId.make(changeId), current.id), `opened ${current.id}`)}>
                  Open
                </button>
              )}
            </div>
            <div className="subagent-log">
              {current.log.map((event, index) => (
                <Event key={`event-${index}`} event={event} />
              ))}
              {current.messages.map((message) => (
                <Message key={message.number} message={message} />
              ))}
            </div>
            <div className="subagent-composer">
              <textarea
                value={draft}
                placeholder="message this subagent…"
                aria-label="subagent message"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(draft);
                  }
                }}
              />
              <button className="create" disabled={draft.trim() === ""} onClick={() => send(draft)}>
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
