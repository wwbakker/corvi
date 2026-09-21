import { type JSX, useEffect, useState } from "react";
import { makeChangesClient } from "@corvi/client";
import { ChangeId } from "@corvi/contracts/changes";
import type { RepositoryViewDto } from "@corvi/contracts/api";
import { checkoutRows } from "./repositoryView.ts";

/** One client, relative to the page's own origin: the browser asks the server that served it. */
const client = makeChangesClient({ baseUrl: "" });

/**
 * The change's repositories as Corvi's own facts: which links exist, their projected state, and
 * what is actually checked out where. A read of the typed client operation, not the extension
 * host's widget plumbing.
 */
export function CheckoutsCard({ changeId }: { changeId: string }): JSX.Element {
  const [views, setViews] = useState<readonly RepositoryViewDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setViews(null);
    setError(null);
    client.inspectRepositories(ChangeId.make(changeId)).then(
      (result) => {
        if (live) setViews(result);
      },
      (cause: Error) => {
        if (live) setError(cause.message);
      },
    );
    return () => {
      live = false;
    };
  }, [changeId]);

  const rows = views ? checkoutRows(views) : [];
  return (
    <section className="widget checkouts" data-testid="checkouts">
      <h3>Checkouts</h3>
      {error && <div className="summary">{error}</div>}
      {!error && views === null && <div className="summary">loading…</div>}
      {views && rows.length === 0 && <div className="summary">No repositories</div>}
      {rows.map((row) => (
        <div className="checkout-row" key={row.name} title={row.location}>
          <span className="checkout-name">{row.name}</span>
          <span className="checkout-state">{row.state}</span>
          <span className="checkout-detail">{row.detail}</span>
        </div>
      ))}
    </section>
  );
}
