import { type JSX } from "react";

/**
 * The step plan an operation shows while it runs: what is still coming, what is going now, what
 * is done, and where a stopped one stopped.
 *
 * Shared by the completion card (a change's) and the update dialog (the app's own) — both read
 * the shared operation-progress shape (`@corvi/contracts/api`'s `OperationStepDto`), so the two
 * journals look the same and say the same words for the same state.
 */

const MARK: Record<StepState, string> = {
  waiting: "○",
  running: "◍",
  done: "●",
  failed: "✕",
};

export type StepState = "waiting" | "running" | "done" | "failed";

export type Step = {
  readonly id: string;
  readonly label: string;
  readonly state: StepState;
  readonly detail?: string;
};

export function StepPlan({ steps }: { steps: readonly Step[] }): JSX.Element {
  return (
    <ul className="progress-steps">
      {steps.map((step) => (
        <li key={step.id} className={step.state}>
          <span className="mark">{MARK[step.state]}</span>
          {step.label}
          {step.detail && <span className="detail">{step.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
