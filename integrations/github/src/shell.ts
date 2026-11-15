/** The Shell capability as the github client uses it: the shared `sh`, `shOrThrow` and `shSoft`
 * from `@corvi/shell/cli`. The service is read optionally, so a scripted Shell in context sees
 * every command and the package's effects stay requirement-free.
 */
export { sh, shOrThrow, shSoft } from "@corvi/shell/cli";
export type { ShellResult } from "@corvi/contracts/capabilities";
