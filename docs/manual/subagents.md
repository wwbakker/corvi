# Subagents

A **subagent** is a visible, persistent agent session that belongs to a change — a conversation,
not a job. An orchestrating agent (or you) delegates work to it, reads its replies, and continues
the conversation. It is a normal terminal window running pi or opencode, so you can watch it and type
into it; the difference is that Corvi knows it as a named participant in the change.

Everything a subagent can do is in the command line and the page: `corvi subagent …` and the
change's Subagents section. Bare `corvi subagent` prints its own usage with the delegation recipe,
and an agent running in a Corvi terminal is pointed at it automatically by the pi and opencode
extensions — invisible outside Corvi.

## Profiles

A profile is a template for a subagent: the harness, the model and effort, and the initial prompt.
Profiles are files, with the same scopes and editing as actions (see
[configuration](configuration.md#subagent-profiles)), and the built-in `reviewer` is a starting
point. `corvi subagent profile list` shows what this change can run — the keys `create` accepts,
`global:reviewer` and the rest, with the files that did not parse and why — and
`corvi subagent profile write <id> --scope global|workspace|repository` adds one (the scope is
explicit; a repository profile is the file `<checkout>/.corvi/subagents/<id>.md`, named with
`--repository <name>`).

## Creating and talking to a subagent

```sh
corvi subagent create global:reviewer --prompt "Review the plan and the diff"
corvi subagent list
corvi subagent await <id>                    # until the latest turn is settled
corvi subagent result <id>                   # its reply; an attributed reply names the turn it answers
corvi subagent send <id> "Now look at the tests"
# prints: sent to <id> (message n)           <- await that n
corvi subagent await <id> --turn <n>         # until turn n is settled
corvi subagent result <id> --turn <n>        # the reply that answers turn n
corvi subagent open <id>                     # recreate the window; never starts work
corvi subagent close <id>                    # presence only; the conversation stays
```

`create` binds three things on purpose: it writes the record, opens the window, and sends the
first message. That message is the profile body rendered with the change facts and the task: the
task fills `{prompt}`, or is appended under `## Task`; with no task, `{prompt}` becomes "Please
await your initial instructions." (a body-less profile, that text alone) — create always sends a
first message. After that, **opening the session and starting work are separate acts**: `open`
recreates the window and resumes the harness session for you to read and type into, and never
triggers a turn.

The subagent behaves as if it were talking to an ordinary user. There is no `ask`/`done` protocol:
a turn is just the subagent's reply, and deciding whether it is a question or a result is the
orchestrator's job. `create` and `send` print the number of the message they appended —
`created <id> (message 1)`, `sent to <id> (message n)` — and you await the number the send
printed. (The reply itself is a later, higher-numbered message, so the send's `n` is the inbound
turn to use; never a reply's number.)

`await <id>` answers only when the latest inbound turn is settled: its reply is parked, or the
subagent is idle with nothing of yours to deliver. An earlier reply no longer answers it while
newer work of yours is pending or in flight; the queued work is delivered when the subagent is
free, and a reply that answers an earlier turn stays parked for `result <id> --turn <n>`. That
tighter default is the behavior change turn identity was added for.

`await <id> --turn <n>` waits for one named subagent's turn n instead, and returns an earlier
already-parked reply even while newer work continues. It cannot be combined with several ids or
`--all`. Every await answers per target: `ready <id> (replied turn <t>, reply <r>)`, or
`ready <id> (replied reply <r>)` for an unattributed legacy reply; `ready <id> (idle)`;
`lost <id>` with `(turn <t>)` when one is known; `interrupted <id> (turn <t>)`; or `timeout` at
the horizon. It takes several ids — `--any` (the default) answers for the first target that
settles, `--all` waits for every one and orders the aggregate `lost` > `interrupted` > `ready` —
and after five minutes it answers `timeout` (exit 6), so the orchestrator can check in on its
subagents and run `await` again. With no subagents at all it answers `timeout` at once. `--all`
pays for that completeness: on `timeout` its already-settled siblings are discarded, so re-issue
the await (a settled target answers again at once) or await each id separately for partial
progress.

`result <id>` is the latest reply; `result <id> --turn <n>` the reply that answers turn n. An
attributed reply prints its identity — `reply 4 (answers turn 3)` — so an orchestrator can check a
reply is the one it is waiting for; a reply written before `in_reply_to` existed prints bare
`reply 4`, with no turn to name. `await` and `result` are read-only: they never acknowledge or
consume a reply, and repeated calls return the same answer.

When you delegate, await the turn you sent instead of polling `show`/`result` with sleeps; keep one
outstanding request per subagent where practical; and check the `(answers turn n)` identity on a
result before treating it as the answer to the request you meant. A reply with no
`(answers turn n)` is unattributed, so prefer `--turn` retrieval for such histories.

## Files

Each subagent is one directory under the change:

```text
<change>/subagents/<id>/
  session.json            # the record and the system log; server-owned
  001-orchestrator.md     # the initial task
  002-subagent.md         # its reply
  003-orchestrator.md     # the next message
```

Every message is a file with a number and a role, so the conversation is part of the change's
record and travels into the archive with it. The server is the only writer.

## Later, unchanged (interruption, reboot)

A subagent lives until you close it, the machine reboots, or the change is completed or cancelled.
After a reboot, the session is gone but everything else is on disk: the subagent reads as **detached**,
and one with a turn in flight reads as **interrupted**. `open` recreates the window and resumes the
harness session, and does no work; **Continue** (or `corvi subagent send`) restarts the interrupted
turn explicitly.
Nothing is restarted behind your back.

## The relay

Corvi's extension inside the harness is what carries the conversation. It parks on
`corvi subagent next`, submits an inbound message as a genuine user turn through the harness's own
API, and relays the settled reply back with `corvi subagent turn`. A settled subagent turn does
not raise a user notification; it waits for the orchestrator, which sees it through `corvi
subagent await` and the Subagents page. The extension is a thin shim: all protocol logic lives in
the CLI and server, and everything is driven through the CLI, so a harness without the extension
still works as a plain terminal — it just cannot reply.
