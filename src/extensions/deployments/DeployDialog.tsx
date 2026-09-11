import { type JSX, useEffect, useRef, useState } from "react";
import { api, post } from "../../web/api.ts";
import { moment } from "../../web/moment.ts";
import { Progress } from "../../web/Progress.tsx";

export type Buildable = {
  runId: number;
  buildNumber: string;
  version?: string;
  branch: string;
  finishedAt?: string;
  url?: string;
  deployedTo: string[];
  running?: boolean;
  startedAt?: string;
  expectedMs?: number;
};

/**
 * Starting a deploy: which version, and where to.
 *
 * The one irreversible thing on the deployments page, so it says what it is about to do in the
 * button rather than on it — `Deploy 20260901_… to production` — and the last environment is
 * marked as the one you cannot take back.
 *
 * Versions come from the service's own builds, newest first, with where each already is. The
 * server refuses to put a version on a later environment before an earlier one has it and
 * succeeded; the dialog says so before you click rather than after.
 */
export function DeployDialog({
  workspace,
  service,
  environments,
  preset,
  open,
  onClose,
  onStarted,
}: {
  /** The context these pipelines belong to. */
  workspace?: string;
  service: string | null;
  environments: string[];
  /** What the row you clicked was offering: a version to promote, and where to. */
  preset?: { version?: string; environment?: string };
  open: boolean;
  onClose: () => void;
  onStarted: (message: string) => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<Buildable[] | null>(null);
  const [version, setVersion] = useState<string>("");
  const [environment, setEnvironment] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open || !service) return;

    setError(null);
    setVersions(null);
    setVersion(preset?.version ?? "");
    setEnvironment(preset?.environment ?? environments[0] ?? "");
    // Read at the moment it opens, not from the row: a row is up to half a minute old, and this
    // is the decision, not the display.
    api<Buildable[]>(
      `/ext/deployments/services/${encodeURIComponent(service)}/versions${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`,
    )
      .then((found) => {
        setVersions(found);
        // The first one with a version, not the first row: a build still in progress is shown
        // but has nothing to select yet.
        setVersion((current) => current || (found.find((v) => v.version)?.version ?? ""));
      })
      .catch((e: Error) => setError(e.message));
  }, [open, service]);

  // What is offered: the builds, plus whatever the row was already pointing at. A service whose
  // build pipeline is named differently — or has none — still has versions running somewhere,
  // and promoting one of those is the whole point of the button that opened this.
  const offered: Buildable[] =
    versions && preset?.version && !versions.some((v) => v.version === preset.version)
      ? [
          {
            runId: 0,
            buildNumber: "",
            version: preset.version,
            branch: "",
            deployedTo: environments.slice(0, Math.max(0, environments.indexOf(preset.environment ?? "") )),
          },
          ...versions,
        ]
      : (versions ?? []);

  const index = environments.indexOf(environment);
  const previous = index > 0 ? environments[index - 1] : undefined;
  const chosen = versions && offered.find((v) => v.version === version);
  // The gate, said before the click: production gets what acceptance proved.
  const blocked =
    previous && chosen && !chosen.deployedTo.includes(previous)
      ? `${version} is not on ${previous} yet`
      : undefined;
  const last = index === environments.length - 1;

  const start = (): void => {
    if (!service) return;
    setBusy(true);
    setError(null);
    post<{ runId: number }>(
      `/ext/deployments/services/${encodeURIComponent(service)}/deploy${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`,
      { version, environment },
    )
      .then(() => {
        onStarted(`deploying ${version} to ${environment}`);
        onClose();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <dialog ref={ref} className="wide" onClose={onClose}>
      <h3>Deploy {service}</h3>
      {error && <div className="error-banner">{error}</div>}

      <div className="row environments">
        {environments.map((name) => (
          <label key={name} className={environment === name ? "pick current" : "pick"}>
            <input
              type="radio"
              name="environment"
              checked={environment === name}
              onChange={() => setEnvironment(name)}
            />
            {name}
          </label>
        ))}
      </div>

      {!versions && <p className="hint">reading what the builds produced…</p>}
      <div className="versions">
        {offered.map((v) => (
          <label
            key={v.runId || v.version}
            className={
              v.running ? "pick building" : version === v.version ? "pick current" : "pick"
            }
          >
            <input
              type="radio"
              name="version"
              disabled={v.running}
              checked={!v.running && version === v.version}
              onChange={() => v.version && setVersion(v.version)}
            />
            {/* Still building: there is no version yet, so nothing here can be picked — it is
                shown so a build you are waiting on does not look like it fell off the list. */}
            <span className="what">{v.version ?? (v.running ? "building…" : "")}</span>
            {/* When it finished, beside what it is: a version string is not something you can
                check against your memory of what you merged, and a time is. */}
            {v.finishedAt && <span className="when">{moment(v.finishedAt)}</span>}
            {/* A build in flight gets the same bar the CI widget draws for a run: how far into
                the pipeline's usual duration this one already is. */}
            {v.running && v.startedAt && (
              <Progress startedAt={v.startedAt} expectedMs={v.expectedMs} />
            )}
            {/* Where it already is, coloured by how far it got: green once it has reached the
                last environment, amber while it is only part of the way. */}
            {v.deployedTo.length > 0 && (
              <span
                className={
                  v.deployedTo.includes(environments[environments.length - 1] ?? "")
                    ? "where state-ok"
                    : "where state-pending"
                }
              >
                on {v.deployedTo.join(" and ")}
              </span>
            )}
            <span className="detail">
              {[v.buildNumber, v.branch].filter(Boolean).join(" · ")}
            </span>
          </label>
        ))}
        {versions?.length === 0 && offered.length === 0 && (
          <p className="hint">no builds with a version — is there a build pipeline for this?</p>
        )}
      </div>

      {blocked && <p className="hint warn">{blocked}: deploy it there first.</p>}

      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <button
          className={last ? "danger" : "create"}
          disabled={busy || !version || !environment || Boolean(blocked)}
          onClick={start}
        >
          {busy ? "Starting…" : `Deploy ${version || "…"} to ${environment}`}
        </button>
      </div>
    </dialog>
  );
}
