/**
 * The change's subagents on its dashboard: one row per instance, with the actions that would
 * otherwise need the command line — reopen a closed one, close a live one, continue an
 * interrupted turn.
 *
 * The card is the only place a subagent with no live window shows up, so it lists every instance
 * rather than only the attached ones, and it hides itself when the change has none. The server
 * owns the conversation (one directory per subagent); this card reads `client.subagents` and
 * re-reads when the server says a window or a change moved, which is also how a turn's activity
 * reaches it.
 */
import { type JSX, useCallback, useEffect, useRef, useState } from "react";

import { ChangeId } from "@corvi/contracts/changes";
import type { SubagentInstanceDto } from "@corvi/contracts/subagents";
import { useChangeClient, useSource, useSourceAvailability } from "../../app-root/sources.ts";
import { gateFailureOf } from "../../app-root/sourceOwner.ts";
import { useServerEvent } from "../../app-root/events.ts";
import { Dot } from "../../dashboard/client/WidgetRows.tsx";

/** What a created subagent got when the machine interrupted it mid-task. */
const CONTINUE_NOTE =
  "The machine was interrupted mid-task. Continue. If you were waiting for information, say so.";

/** The row's dot: interrupted and awaiting a reply are what asks for you; a working subagent is
 * busy rather than fine; a detached one has nothing to say. */
const dotOf = (instance: SubagentInstanceDto): string | undefined =>
  instance.interrupted
    ? "error"
    : instance.awaitingReply
      ? "warn"
      : instance.activity === "working"
        ? "ok"
        : undefined;

export function SubagentsCard({
  changeId,
  onOpenPage,
}: {
  changeId: string;
  /** Where to land after reopening a subagent: its recreated window is selected server-side, so
   * the terminal page is already showing it. */
  onOpenPage: (page: "terminals") => void;
}): JSX.Element | null {
  const client = useChangeClient();
  // The change's workspace: availability drives whether the card asks at all, and the reloads.
  // The transport gate is still the authority.
  const source = useSource();
  const availability = useSourceAvailability(source);
  const blocked = availability.status._tag !== "available";
  const generation = availability.generation;
  // null until the first answer, so the card does not appear before it has anything to say.
  const [instances, setInstances] = useState<SubagentInstanceDto[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The subagent whose row is waiting for its action, so only that row's buttons are held back.
  const [acting, setActing] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback((): void => {
    // A blocked source keeps the same-generation list; recovery re-runs this through the deps.
    // The sequence guard stops a late old-generation answer from republishing.
    if (blocked) return;
    const seq = ++loadSeq.current;
    client
      .subagents.list(ChangeId.make(changeId))
      .then((next) => {
        if (seq === loadSeq.current) setInstances(next);
      })
      .catch((e: unknown) => {
        if (seq !== loadSeq.current) return;
        if (gateFailureOf(e) !== undefined) return; // the banner explains, not this notice
        setNotice(e instanceof Error ? e.message : String(e));
      });
  }, [changeId, client, blocked, generation]);

  useEffect(load, [load]);
  // A retargeted target's instances were never the new target's: drop them and invalidate any
  // in-flight load. A same-generation outage is not this.
  useEffect(() => {
    loadSeq.current += 1;
    setInstances(null);
  }, [generation]);
  useServerEvent("changes", load);
  useServerEvent("windows", load);

  /** Run one row's action, keeping its buttons held until it settles and re-reading the list:
   * presence and interruption are the server's answer, not something to guess. */
  const act = async (id: string, work: () => Promise<unknown>): Promise<void> => {
    if (acting !== null) return;
    setActing(id);
    setNotice(null);
    try {
      await work();
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  };

  const open = (instance: SubagentInstanceDto): Promise<void> =>
    act(instance.id, async () => {
      await client.subagents.open(ChangeId.make(changeId), instance.id);
      onOpenPage("terminals");
    });

  const close = (instance: SubagentInstanceDto): Promise<void> =>
    act(instance.id, () => client.subagents.close(ChangeId.make(changeId), instance.id));

  /** Continue is a submitted orchestrator message, not a bare rescue: the note says what the
   * harness lost. The key makes a retried request the same message rather than two. */
  const resume = (instance: SubagentInstanceDto): Promise<void> =>
    act(instance.id, () =>
      client.subagents.send(
        ChangeId.make(changeId),
        instance.id,
        { text: CONTINUE_NOTE },
        crypto.randomUUID(),
      ),
    );

  // Nothing to show: no instances and nothing to report. A failed first read still says so.
  if (notice === null && (instances ?? []).length === 0) return null;

  return (
    <section className="widget subagents" data-testid="subagents">
      <h3>Subagents</h3>
      {notice && <div className="summary">{notice}</div>}
      {(instances ?? []).map((instance) => (
        <div className="item" key={instance.id}>
          <span className="toggle-spacer" />
          <Dot state={dotOf(instance)} />
          <span className="label" title={instance.profile}>
            {instance.label}
          </span>
          <span className="detail">
            {instance.presence} · {instance.activity}
          </span>
          {instance.interrupted && <span className="badge warn">interrupted</span>}
          {instance.awaitingReply && <span className="badge warn">awaiting reply</span>}
          {instance.presence === "detached" ? (
            <button disabled={acting !== null} onClick={() => void open(instance)}>
              Open
            </button>
          ) : (
            <button disabled={acting !== null} onClick={() => void close(instance)}>
              Close
            </button>
          )}
          {instance.interrupted && (
            <button disabled={acting !== null} onClick={() => void resume(instance)}>
              Continue
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
