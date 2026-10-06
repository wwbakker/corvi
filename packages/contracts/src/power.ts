/** Powering a machine down when its agents are done: the shapes the arm control and the
 * server's power module share.
 *
 * Each machine's own server owns the arm state: the local server fans an arm out to the
 * selected remotes and arms itself, and every target reports its own result. `targets` are
 * source ids — `""` is this machine, a non-empty id names a remote workspace's server.
 */
import { Schema } from "effect"

/** Where an armed machine is: idle after a disarm, armed and waiting for its agents, or armed
 * with the countdown running. */
export const PowerPhase = Schema.Literals(["disarmed", "armed", "counting-down"])
export type PowerPhase = typeof PowerPhase.Type

/** One agent on a machine, marked by whether it is still working. The power control lists these
 * per machine; the quiet rule is exactly "none of them is working". */
export const PowerAgentSchema = Schema.Struct({
  label: Schema.String,
  working: Schema.Boolean,
})
export type PowerAgent = typeof PowerAgentSchema.Type

/** What a page reads to draw the countdown and the agents it is waiting on. `deadline` is the
 * ISO instant the power command runs, present only while `counting-down`; `error` is the last
 * power-off failure, so a failed command is surfaced instead of disappearing; `agents` is the
 * server-computed list the control shows and the monitor waits on, so both read one list. */
export const PowerStateSchema = Schema.Struct({
  phase: PowerPhase,
  deadline: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  agents: Schema.Array(PowerAgentSchema),
})
export type PowerStateDto = typeof PowerStateSchema.Type

/** An arm request: the source ids to arm. `""` is this machine; a non-empty id is a remote
 * workspace's source id. */
export const PowerArmRequestSchema = Schema.Struct({
  targets: Schema.Array(Schema.String),
})
export type PowerArmRequestDto = typeof PowerArmRequestSchema.Type

/** How arming one target went. A free-text error would push the fan-out and the dialog into
 * matching on it, so the outcome is typed: `armed` succeeded; `unreachable` could not be
 * contacted; `unsupported` is a server without the routes (an older one); `refused` answered
 * but said no. `detail` carries the server's own words beside the status. */
export const PowerTargetStatus = Schema.Literals([
  "armed",
  "unreachable",
  "unsupported",
  "refused",
])
export type PowerTargetStatus = typeof PowerTargetStatus.Type

/** One target's answer to an arm. */
export const PowerTargetResultSchema = Schema.Struct({
  source: Schema.String,
  status: PowerTargetStatus,
  detail: Schema.optional(Schema.String),
})
export type PowerTargetResultDto = typeof PowerTargetResultSchema.Type

/** What an arm answers: one result per selected target, so one unreachable target does not
 * hide the others. */
export const PowerArmResponseSchema = Schema.Struct({
  results: Schema.Array(PowerTargetResultSchema),
})
export type PowerArmResponseDto = typeof PowerArmResponseSchema.Type
