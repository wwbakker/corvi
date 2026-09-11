/**
 * The wizard submodule's public face: the "Create change" wizard, which composes the
 * extensions' steps through the host's client contract. The server half is absent — a change
 * is created through the change module's own route, and the steps it offers are listed by the
 * `/api/wizard` route — so the face is the client component itself.
 */
export { Wizard } from "./client/Wizard.tsx";
