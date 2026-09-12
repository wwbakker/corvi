/** A page the sidebar offers: served at `/<id>`, rendered by the extension's client half
 * exporting `page`. The page exists for a workspace when the extension does. */
export type Page = { id: string; title: string };
