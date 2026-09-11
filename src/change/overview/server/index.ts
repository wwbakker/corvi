/**
 * The overview submodule's public face for the server: the summary a change's card is built
 * from. It composes the change, its terminals and the host's contributed facts, which is why
 * the dashboard lives in a submodule rather than beside `change/server` — composing `terminal`
 * and the host from inside `change` would close a cycle.
 *
 * The browser half (`../client/`) holds the cards that render the summary and is not
 * re-exported here: a server barrel pulled into the page's bundle would drag the Effect
 * runtime and the CLIs with it.
 */
export { summaryOf, worst, type ChangeSummary } from "./summary.ts";
