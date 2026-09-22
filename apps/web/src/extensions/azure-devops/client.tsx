import { type JSX, useEffect, useState } from "react";
import { makeWireClient } from "@corvi/client";
import type { PageComponent } from "../../integrations/client.tsx";
import { moment } from "../../app-root/moment.ts";
import { DeployDialog } from "./DeployDialog.tsx";
import { autoDeployedApp } from "@corvi/contracts/integrations/azure-devops";
import { ServicesResponseSchema, type Deployed, type Service } from "@corvi/contracts/integrations/azure-devops";

export type { Deployed, Service };

/** The transport: the page's classified `ClientError`, with this extension's own DTOs. */
const wire = makeWireClient({ baseUrl: "" });

/**
 * What is deployed where: one row per service, one column per environment.
 *
 * Not part of a change, and deliberately so — you deploy a service's build, and which change
 * produced it is a separate question. "What is on accept?" gets asked before a release and
 * during an incident, when there is no change open to ask it from.
 *
 * The state shown is Azure DevOps's own: a deploy run records the version and the environment
 * it was given, and the newest run per environment is the truth about that environment.
 */
export function AzureDevopsPage({ workspace }: { workspace?: string }): JSX.Element {
  const [services, setServices] = useState<Service[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deploying, setDeploying] = useState<{
    service: string;
    preset?: { version?: string; environment?: string };
  } | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const load = (): Promise<void> =>
      wire
        .request(
          "GET",
          `/ext/azure-devops/services${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`,
          ServicesResponseSchema,
        )
        .then((r) => {
          setServices(r.services);
          setError(r.error ?? null);
        })
        .catch((e: Error) => setError(e.message));
    void load();
    // A deploy takes minutes, and this is a page you look at rather than watch.
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [generation, workspace]);

  // The environments every service has, in the order they are deployed to.
  const columns = services?.[0]?.environments.map((e) => e.environment) ?? [];

  return (
    <div className="page">
      <header>
        <h2>Azure DevOps</h2>
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
          // It will show up as "deploying" on the next read, which is now rather than in 30s.
          setGeneration((g) => g + 1);
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
