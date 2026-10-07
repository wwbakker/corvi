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
import { useChangeClient } from "../../app-root/sources.ts";
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
  onFocusPane,
}: {
  changeId: string;
  platform: Platform;
  terminal: { url: string | null; error: string | null; create: () => void };
  /** Bring the selected subagent's window to the front by stable identity (an explicit selection
   * only). */
  onFocusPane: (windowId: string) => void;
}): JSX.Element {
  const client = useChangeClient();
  const [instances, setInstances] = useState<SubagentInstanceDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // The subagent whose terminal the page shows when the user has not chosen one. It is pinned the
  // first time there is anything to show, so a background creation or a reorder cannot move the
  // rendered/input pane out from under the user.
  const [pinned, setPinned] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((): void => {
    client
      .subagents.list(ChangeId.make(changeId))
      .then(setInstances)
      .catch((e: Error) => setNotice(e.message));
  }, [changeId]);

  useEffect(load, [load]);
  useServerEvent("changes", load);
  useServerEvent("windows", load);

  useEffect(() => {
    if (pinned !== null || selected !== null) return;
    const first = instances[0];
    if (first !== undefined) setPinned(first.id);
  }, [instances, pinned, selected]);

  const activeId = selected ?? pinned;
  const current = activeId === null ? undefined : instances.find((instance) => instance.id === activeId);
  // The pane the embedded terminal shows is the subagent's own live pane, named by the stable
  // pane id from its DTO — never a positional join against another list. With no live pane the
  // page shows a placeholder rather than falling back to the change's active shell, so keystrokes
  // can never land in a terminal that is not this subagent's. A selection whose record is gone
  // keeps the pinned id (no auto-switch to a survivor); its placeholder asks for another choice
  // instead, matching the fact that no Open button exists for a record that is not there.
  const shownPaneId = current?.paneId ?? null;
  const selectedIsGone = activeId !== null && current === undefined;

  // Focusing the terminal on a subagent you opened is the point of putting the two side by side.
  // Only the click itself focuses, and it names the window/pane by identity: a later `instances`
  // refresh must not fire a deferred selection the user did not just ask for, and a positional
  // index from another read must not land the focus on a different window.
  const chooseSubagent = (instance: SubagentInstanceDto): void => {
    setSelected(instance.id);
    if (instance.presence === "attached" && instance.windowId !== undefined) {
      onFocusPane(instance.windowId);
    }
  };

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
      await client.subagents.send(ChangeId.make(changeId), current.id, { text }, crypto.randomUUID());
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
        {selectedIsGone ? (
          <p className="hint">this subagent is no longer here — choose another from the list</p>
        ) : shownPaneId === null ? (
          // The record exists but has no live pane: say so rather than attach this terminal to
          // whatever shell the change happens to have active. Its Open button is in the actions
          // row beside the conversation.
          <p className="hint">this subagent has no live terminal — use Open to start one</p>
        ) : (
          <TerminalPane
            changeId={changeId}
            url={terminal.url}
            sessionId={shownPaneId}
            error={terminal.error}
            visible
            platform={platform}
            onNewWindow={terminal.create}
          />
        )}
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
              onClick={() => chooseSubagent(instance)}
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
                <button onClick={() => void act(() => client.subagents.close(ChangeId.make(changeId), current.id), `closed ${current.id}`)}>
                  Close
                </button>
              ) : (
                <button onClick={() => void act(() => client.subagents.open(ChangeId.make(changeId), current.id), `opened ${current.id}`)}>
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
