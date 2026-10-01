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
import { type JSX, useCallback, useEffect, useRef, useState } from "react";

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

/** When an interrupted turn started, from the record's own log. */
const interruptedSince = (instance: SubagentInstanceDto): string | undefined =>
  instance.interrupted
    ? [...instance.log].reverse().find((event) => event.kind === "turn_started")?.at
    : undefined;

export function SubagentsPane({
  changeId,
  platform,
  terminal,
  windowId,
  windowsCount,
  onFocusWindow,
}: {
  changeId: string;
  platform: Platform;
  terminal: { url: string | null; error: string | null; create: () => void };
  /** The window the embedded terminal shows: the active one, which selecting a subagent sets. */
  windowId: string | null;
  windowsCount: number;
  /** Switch the shared session to a window **without** leaving this page. */
  onFocusWindow: (index: number) => void;
}): JSX.Element {
  const [instances, setInstances] = useState<SubagentInstanceDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((): void => {
    apiClient
      .subagents.list(ChangeId.make(changeId))
      .then(setInstances)
      .catch((e: Error) => setNotice(e.message));
  }, [changeId]);

  useEffect(load, [load]);
  useServerEvent("changes", load);
  useServerEvent("windows", load);

  const current = instances.find((instance) => instance.id === selected) ?? instances[0];

  // Focusing the terminal on the selected subagent's window is the point of putting the two side
  // by side. It runs when the *selection* changes, not whenever an index shifts, and it goes
  // through a ref: the callback's identity changes on every app render, and depending on it here
  // would re-fire the focus forever.
  const focus = useRef(onFocusWindow);
  focus.current = onFocusWindow;
  const chosen = useRef<SubagentInstanceDto | undefined>(current);
  chosen.current = current;
  useEffect(() => {
    const instance = chosen.current;
    if (instance?.presence === "attached" && instance.windowIndex !== undefined) {
      focus.current(instance.windowIndex);
    }
  }, [current?.id, current?.presence]);

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

  /** Send text, keeping the draft until it lands, and never twice at once. The idempotency key
   * makes a retried click a no-op on the server rather than a duplicated message. */
  const send = async (text: string): Promise<void> => {
    if (!current || text.trim() === "" || sending) return;
    setSending(true);
    setNotice(null);
    try {
      await apiClient.subagents.send(ChangeId.make(changeId), current.id, { text }, crypto.randomUUID());
      setDraft("");
      setNotice(`sent to ${current.id}`);
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  if (instances.length === 0) {
    return (
      <div className="page subagents-pane">
        <header>
          <h2>Subagents</h2>
          <span className="spacer" />
          {notice && <span className="summary">{notice}</span>}
        </header>
        <p className="hint">
          no subagents yet — create one from the command line
          (`corvi subagent create &lt;profile&gt;`).
        </p>
      </div>
    );
  }

  const since = current === undefined ? undefined : interruptedSince(current);
  // One timeline: the message sequence and the system log interleaved by time, not two lists.
  const timeline: { at: string; key: string; node: JSX.Element }[] = current
    ? [
        ...current.log.map((event, index) => ({
          at: event.at,
          key: `event-${index}`,
          node: <Event event={event} />,
        })),
        ...current.messages.map((message) => ({
          at: message.at,
          key: `message-${message.number}`,
          node: <Message message={message} />,
        })),
      ].sort((left, right) => left.at.localeCompare(right.at))
    : [];

  return (
    <div className="subagents-layout">
      <div className="terminal-host subagent-terminal">
        <TerminalPane
          changeId={changeId}
          url={terminal.url}
          windowId={windowId}
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
              {instance.label}
              {instance.interrupted ? (
                <span className="badge warn">interrupted</span>
              ) : (
                <span className="summary">{instance.presence}</span>
              )}
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
              {current.interrupted && since !== undefined && (
                <span className="badge warn">interrupted since {clock(since)}</span>
              )}
              {current.interrupted && (
                <button className="create" disabled={sending} onClick={() => void send(CONTINUE_NOTE)}>
                  Continue
                </button>
              )}
              {current.presence === "attached" ? (
                <button onClick={() => void act(() => apiClient.subagents.close(ChangeId.make(changeId), current.id), `closed ${current.id}`)}>
                  Close
                </button>
              ) : (
                <button onClick={() => void act(() => apiClient.subagents.open(ChangeId.make(changeId), current.id), `opened ${current.id}`)}>
                  Open
                </button>
              )}
            </div>
            <div className="subagent-log">
              {timeline.map((entry) => (
                <div key={entry.key}>{entry.node}</div>
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
                    void send(draft);
                  }
                }}
              />
              <button className="create" disabled={draft.trim() === "" || sending} onClick={() => void send(draft)}>
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
