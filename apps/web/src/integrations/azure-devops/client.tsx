import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceWireClient } from "../../app-root/sources.ts";
import type { PageComponent } from "../client.tsx";
import { moment } from "../../app-root/moment.ts";
import { usePolled, type PollReason } from "../../app-root/poll.ts";
import { duration, Progress } from "../../app-root/Progress.tsx";
import { RefreshIcon } from "../../app-root/icons.tsx";
import { aborted } from "../../app-root/api.ts";
import { DeployDialog } from "./DeployDialog.tsx";
import { autoDeployedApp } from "@corvi/contracts/integrations/azure-devops";
import { ServicesResponseSchema, type Deployed, type Service } from "@corvi/contracts/integrations/azure-devops";

export type { Deployed, Service };

/** How often the page reads while something is deploying, and while nothing is. Watching a deploy
 * is the one thing this page is for; an idle page is a glance now and then. */
const WATCHING = 10_000;
const IDLE = 60_000;

/**
 * The header's refresh control: what was last read, how old that is, and the button that reads it
 * again.
 *
 * The age has a clock of its own — one second, one small component — because the table under it
 * must not re-render every second for a tooltip, and because an age frozen at the last poll is a
 * tooltip that lies the moment you hover it.
 */
function RefreshControl({
  refreshing,
  updatedAt,
  intervalMs,
  onRefresh,
}: {
  refreshing: boolean;
  updatedAt: number | undefined;
  intervalMs: number;
  onRefresh: () => void;
}): JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const age = updatedAt === undefined ? "not read yet" : `updated ${duration(now - updatedAt)} ago`;
  // The button is disabled for a reason only the button knows: a second click would only start
  // another read beside the first one, and there is nothing to queue it behind.
  return (
    <button
      type="button"
      className={refreshing ? "refresh refreshing" : "refresh"}
      aria-label="Refresh"
      // `aria-disabled`, not `disabled`: a real disabled button drops focus and stops showing its
      // own tooltip, which is the one thing this control exists to say.
      aria-disabled={refreshing}
      title={`${age} · refreshing every ${duration(intervalMs)}`}
      onClick={() => {
        if (!refreshing) onRefresh();
      }}
    >
      <RefreshIcon title="Refresh" />
    </button>
  );
}

/**
 * What is deployed where: one row per service, one column per environment.
 *
 * Not part of a change, and deliberately so — you deploy a service's build, and which change
 * produced it is a separate question. "What is on accept?" gets asked before a release and
 * during an incident, when there is no change open to ask it from.
 *
 * The state shown is Azure DevOps's own: a deploy run records the version and the environment
 * it was given, and the newest run per environment is the truth about that environment.
 *
 * What is on screen is kept current rather than looked at: a page opened while something deploys
 * reads every ten seconds, and an idle one every minute. The first read is live — arriving is the
 * moment you want the truth, not the answer the last visit left in the cache — and so is the
 * button.
 */
export function AzureDevopsPage({ workspace }: { workspace?: string }): JSX.Element {
  // The extension's routes live on the server that hosts the workspace: the local origin, or the
  // selected remote workspace's server through the gateway.
  const wire = useWorkspaceWireClient();
  const [services, setServices] = useState<Service[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deploying, setDeploying] = useState<{
    service: string;
    preset?: { version?: string; environment?: string };
  } | null>(null);
  // Only the first read of this page is live by arrival. The poll restarts when the cadence
  // changes, which is not a reason to read live again — hence a ref, not the loader's argument.
  // It is spent when a read settles, not when one is sent: a doomed attempt (an aborted StrictMode
  // mount) must not promote the read that survives it to a plain poll.
  const firstLoad = useRef(true);
  // The newest read, so an answer that belongs to an older attempt cannot paint over a newer one:
  // a manual refresh and a tick may be in flight together.
  const loadSeq = useRef(0);

  const load = useCallback(
    (signal: AbortSignal, reason: PollReason): Promise<void> => {
      const live = reason === "manual" || firstLoad.current;
      const seq = ++loadSeq.current;
      const query = new URLSearchParams({
        ...(workspace ? { workspace } : {}),
        ...(live ? { refresh: "1" } : {}),
      });
      return wire
        .request("GET", `/ext/azure-devops/services?${query}`, ServicesResponseSchema, { signal })
        .then((r) => {
          firstLoad.current = false;
          if (seq !== loadSeq.current) return;
          setServices(r.services);
          setError(r.error ?? null);
        })
        .catch((e: Error) => {
          // A read the page itself cancelled — a tick overtaken by a cadence change — is not a
          // failure to report, and not a read either: the next one still owes the live answer.
          if (aborted(e)) return;
          firstLoad.current = false;
          if (seq !== loadSeq.current) return;
          setError(e.message);
        });
    },
    [workspace, wire],
  );

  // Queued counts as pending, as it already does in the state dot: a deploy waiting for an agent
  // is a deploy you are waiting for.
  const watching = services?.some((s) => s.environments.some((e) => e.state === "pending")) ?? false;
  const cadence = watching ? WATCHING : IDLE;
  const { refreshing, updatedAt, refresh } = usePolled(load, cadence);

  // The environments every service has, in the order they are deployed to.
  const columns = services?.[0]?.environments.map((e) => e.environment) ?? [];

  return (
    <div className="page">
      <header>
        <h2>Azure DevOps</h2>
        <RefreshControl
          refreshing={refreshing}
          updatedAt={updatedAt}
          intervalMs={cadence}
          onRefresh={refresh}
        />
      </header>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {!services && !error && <p className="hint">loading…</p>}
      {services && services.length === 0 && !error && (
        <p className="hint">no deploy pipelines found</p>
      )}
      {services && services.length > 0 && (
        <table className="table deployments">
          <thead>
            <tr>
              <th>Service</th>
              {columns.map((name) => (
                <th key={name}>{name}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {services.map((service) => {
              // Environments that hold different versions are the thing you are looking for:
              // production behind acceptance is normal, and knowing by how much is the point.
              const versions = new Set(service.environments.map((e) => e.version ?? ""));
              // The next environment that has not got what the one before it has: the promotion
              // this row is asking for, if it is asking for one.
              const promote = service.environments.find((e, i) => {
                const before = service.environments[i - 1];
                return before?.state === "ok" && before.version && before.version !== e.version;
              });
              const source = promote && service.environments[service.environments.indexOf(promote) - 1];
              // The `*-app` pipelines deploy to the first environment on every merge, on their
              // own — nothing here decides that, so the generic button offering to is a lie for
              // them. Only promoting what accept already proved to the next environment applies.
              const autoDeployed = autoDeployedApp(service.name);
              return (
                <tr key={service.name} className={versions.size > 1 ? "differs" : ""}>
                  <td>{service.name}</td>
                  {service.environments.map((e) => (
                    <td key={e.environment}>
                      <span className={`dot ${e.state}`} />
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noreferrer">
                          {e.version ?? "—"}
                        </a>
                      ) : (
                        <span className="version">{e.version ?? "—"}</span>
                      )}
                      {/* When, and how it went. Hidden on a narrow window: the version and its
                          colour are the row, this is the footnote — and the exact time is a
                          hover away, for when "4d ago" is not precise enough. */}
                      <span className="detail" title={e.at ? moment(e.at) : undefined}>
                        {e.detail}
                      </span>
                      {/* A deploying environment says how far along it is, whether or not the
                          pipeline has an estimate to measure it against — an unknown bar is still
                          the truth about a deploy that is going. The bar only: the cell has a
                          version and a footnote to hold too, so the elapsed and typical times are
                          the bar's own tooltip. */}
                      {e.state === "pending" && e.at && (
                        <Progress startedAt={e.at} expectedMs={e.expectedMs} />
                      )}
                    </td>
                  ))}
                  <td className="actions">
                    {/* The promotion the row is already asking for, spelled out, and the general
                        case behind it. */}
                    {promote && source?.version && (
                      <button
                        onClick={() =>
                          setDeploying({
                            service: service.name,
                            preset: { version: source.version, environment: promote.environment },
                          })
                        }
                      >
                        Promote to {promote.environment}
                      </button>
                    )}
                    {!autoDeployed && (
                      <button onClick={() => setDeploying({ service: service.name })}>Deploy…</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <DeployDialog
        workspace={workspace}
        service={deploying?.service ?? null}
        environments={columns}
        preset={deploying?.preset}
        open={deploying !== null}
        onClose={() => setDeploying(null)}
        onStarted={(message) => {
          setNotice(message);
          setTimeout(() => setNotice(null), 8000);
          // Read now: what the run we just started changes is this page's answer, and it is live
          // for exactly that reason.
          refresh();
        }}
      />
      <p className="hint">
        The newest run per environment, as Azure DevOps recorded it — including one that failed,
        which leaves the previous version running and says so.
      </p>
    </div>
  );
}

/** The page, as the page's PageHost renders it. */
export const page: PageComponent = AzureDevopsPage;
