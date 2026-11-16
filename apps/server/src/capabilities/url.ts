/** The URL rules the gateway, the event fan-in, the settings write and pairing share.
 *
 * A remote target is only ever fetched over http(s), and a redirect is never followed: the
 * remote's device token rides on the request, and following it would hand the token to whoever
 * the redirect names. The checks live here so every caller refuses the same things.
 */

/** Statuses `fetch` would follow. A remote target is never allowed to redirect us. */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** An http(s) URL, or undefined for anything else — including a value that is not a URL. */
export const parseHttpUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};
