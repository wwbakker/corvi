/**
 * Naming conventions for deploy pipelines, shared between the backend (which reads Azure DevOps)
 * and the browser (which decides what to offer on the page) — the same split as `branch.ts`.
 *
 * Deliberately its own file rather than living in the deployments implementation
 * (`src/extensions/deployments/server.ts`): that module calls out to the
 * `az` CLI and pulls in the rest of the backend with it, which has no business in a browser
 * bundle. A convention that both sides need to agree on cannot live somewhere only one of them
 * can import.
 */

/** `*-app` pipelines build and deploy to the first environment on every merge, on their own —
 * there is no separate build pipeline, and no button that offers to deploy them manually. */
export const autoDeployedApp = (service: string): boolean => service.endsWith("-app");
