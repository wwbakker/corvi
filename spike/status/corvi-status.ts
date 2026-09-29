/**
 * A stand-in for the `corvi` CLI's status call. The reporter shells out to it; it reads its own
 * session id *and incarnation* from the environment the terminal host seeded
 * (`CORVI_SESSION_ID`, `CORVI_SESSION_INCARNATION`) and POSTs the status to the stub endpoint —
 * it writes nothing to the terminal.
 *
 *   CORVI_SESSION_ID=s1 CORVI_SESSION_INCARNATION=2 CORVI_STATUS_URL=http://… \
 *     node corvi-status.ts working --name pi --session-name "Fix login" --message "…"
 */
const url = process.env.CORVI_STATUS_URL;
const sessionId = process.env.CORVI_SESSION_ID;
const incarnation = Number(process.env.CORVI_SESSION_INCARNATION ?? "0");
const args = process.argv.slice(2);
const status = args[0];
if (url === undefined || sessionId === undefined || status === undefined || (status !== "working" && status !== "waiting" && status !== "clear")) {
  console.error("usage: CORVI_SESSION_ID=… CORVI_SESSION_INCARNATION=… CORVI_STATUS_URL=… corvi-status.ts <working|waiting|clear> [--name N] [--session-name S] [--message M]");
  process.exit(2);
}
const valueOf = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const name = valueOf("--name");
const sessionName = valueOf("--session-name");
const message = valueOf("--message");
const response = await fetch(`${url}/api/status`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    sessionId,
    incarnation,
    status,
    ...(name ? { name } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(message ? { message } : {}),
  }),
});
if (!response.ok) {
  console.error(`status endpoint answered ${response.status}`);
  process.exit(1);
}
