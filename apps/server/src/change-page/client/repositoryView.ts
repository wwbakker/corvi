/** The checkouts card's view model: repository facts, no extension host. */
import type { RepositoryViewDto } from "@corvi/contracts/api";

export type CheckoutRow = {
  readonly name: string;
  readonly state: RepositoryViewDto["state"];
  /** The observed branch, the short head, or that there is no checkout. */
  readonly detail: string;
  readonly location: string;
};

const short = (head: string): string => head.slice(0, 7);

export const describeCheckout = (view: RepositoryViewDto): string =>
  view.checkout._tag === "Missing"
    ? "no checkout"
    : view.checkout.branch
      ? `${view.checkout.branch}${view.checkout.head ? ` @ ${short(view.checkout.head)}` : ""}`
      : view.checkout.head
        ? `${short(view.checkout.head)} (detached)`
        : "present";

export const checkoutRows = (views: readonly RepositoryViewDto[]): readonly CheckoutRow[] =>
  views.map((view) => ({
    name: view.directoryName,
    state: view.state,
    detail: describeCheckout(view),
    location: view.checkoutLocation,
  }));
