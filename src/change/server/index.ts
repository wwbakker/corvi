/**
 * The change module's public face for the server: the pure edit rule, the store, and one file
 * per operation. Routes and other core modules enter here; the module's own files import each
 * other (and the store) directly, which is what keeps this barrel cycle-free.
 *
 * The client half (`../client/`) has its own entry points and is not re-exported here: a
 * server barrel pulled into the browser bundle would drag the filesystem and the CLIs with it.
 */
export { applyPatch } from "../model.ts";

export {
  root,
  archiveRoot,
  CORE_SIDECARS,
  changeDir,
  archiveDir,
  readChange,
  writeChange,
  readSidecar,
  writeSidecar,
  listExtensionFiles,
  readExtensionFile,
  writeExtensionFile,
  setExtensionData,
  archiveChange,
  listChanges,
} from "./store.ts";

export { createChange, type CreateChangeInput } from "./create.ts";

export { startChange, startChangeWithWorkflow, type Started } from "./start.ts";

export {
  completeChange,
  completionOf,
  progressOf,
  stepsFor,
  verdict,
  type Completion,
  type CompletionReason,
  type CompletionRefusal,
} from "./complete.ts";

export { cancelChange, looseEnds, type Cancelled, type NeedsForce } from "./cancel.ts";

export { refreshTitles } from "./titles.ts";

export { ideationPromptFor } from "./plan.ts";

export { describeChange, prDescription } from "./description.ts";

export { branchFor, PLAN_FILE, slugFor } from "../../domain/change.ts";
