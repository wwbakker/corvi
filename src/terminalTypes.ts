/** What a coding agent in a tmux window is doing, as it says itself. Its own file so the page
 * can have the type without importing the server's terminal machinery. */
export type AgentState = "working" | "waiting";
