/** The shell capability's public interface. The tag, its shape and the result type are the
 * contract's (`@corvi/contracts/capabilities`); this package owns the implementation
 * (`./node`) and re-exports the interface so a caller that wants both needs one import.
 */
export { Shell, type Result, type ShellShape } from "@corvi/contracts/capabilities";
