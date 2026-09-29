/**
 * A stand-in for the `corvi` CLI's status call. The reporter shells out to it; it reads its own
 * session id from the environment the terminal host seeded (`CORVI_SESSION_ID`) and POSTs the
 * status to the stub endpoint — it writes nothing to the terminal.
 *
 *   CORVI_SESSION_ID=s1 CORVI_STATUS_URL=http://… node corvi-status.ts working --name pi --message "…"
 */
const url = process.env.CORVI_STATUS_URL;
const sessionId = process.env.CORVI_SESSION_ID;
const args = process.argv.slice(2);
const status = args[0];
if (url === undefined || sessionId === undefined || status === undefined) {
  console.error("usage: CORVI_SESSION_ID=… CORVI_STATUS_URL=… corvi-status.ts <working|waiting|clear> [--name N] [--message M]");
  process.exit(2);
}
const valueOf = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const response = await fetch(`${url}/api/status`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    sessionId,
    status,
    ...(valueOf("--name") ? { name: valueOf("--name") } : {}),
    ...(valueOf("--message") ? { message: valueOf("--message") } : {}),
  }),
});
if (!response.ok) {
  console.error(`status endpoint answered ${response.status}`);
  process.exit(1);
}
