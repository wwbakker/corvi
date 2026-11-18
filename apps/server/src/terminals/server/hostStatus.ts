/**
 * What the running host is, versus the one this server would have started.
 *
 * The answer begins with `host.sock.owner.json`, so the common cases — no host, or ours — cost a
 * file read on the status route's poll. Only a host that is not ours is asked how many sessions it
 * holds, because that count is what the restart warning is about.
 */
import type { HostStatusDto } from "@corvi/contracts/api";

import { hostClient, hostOptions, hostRunning } from "./host.ts";
import { identityOfOptions, liveHostOwner } from "../host/client.ts";
import { identityOf, mismatches } from "../host/identity.ts";
import { presentStatus, statusOf } from "./status.ts";

const notRunning: HostStatusDto = { running: false, identity: null, stale: [] };

export const hostStatus = async (): Promise<HostStatusDto> => {
  const options = hostOptions();
  const owner = liveHostOwner(options.socket);
  if (owner === undefined) return notRunning;
  const identity = identityOf(owner);
  const stale = mismatches(identityOfOptions(options), identity);
  if (stale.length === 0) return { running: true, identity, stale: [] };
  // Asking for the client adopts the host as it is — it never replaces one — so the counts below
  // are the ones a restart would end. A host that died between the two reads is not one to start
  // from a status read, so a missing socket ends the answer here.
  if (!hostRunning()) return notRunning;
  const sessions = await hostClient()
    .then((client) => client.list())
    .catch(() => []);
  const live = sessions.filter((session) => session.alive);
  return {
    running: true,
    identity,
    stale,
    sessions: {
      live: live.length,
      // The status the presenter shows: the CLI store first, the host's own OSC parse otherwise.
      working: live.filter(
        (session) =>
          presentStatus(statusOf(session.id, session.incarnation), session.status)?.state === "working",
      ).length,
    },
  };
};
