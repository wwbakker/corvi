/**
 * Which URLs the app window keeps, and which it hands to the system. Pure, so the rule can be
 * tested without Electron.
 */

/** Whether a URL is the app's own page. Everything else is a link to somewhere else. */
export const isOursUrl = (url: string): boolean => {
  try {
    const { hostname, protocol } = new URL(url);
    return (
      (protocol === "http:" || protocol === "https:") &&
      (hostname === "127.0.0.1" || hostname === "localhost")
    );
  } catch {
    return false;
  }
};

/** Whether a URL that is not ours may be opened by the system: a web page or a mail address. A
 * `file:` URL is what a file dropped on the window navigates to, and opening it would run the
 * file's default program; any other scheme is not a link a page offers. */
export const opensExternally = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
};
