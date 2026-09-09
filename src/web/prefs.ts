/**
 * Browser-side preferences, in cookies rather than localStorage.
 *
 * The app serves itself from a fresh port every launch, and an origin includes the port — so
 * anything in localStorage is forgotten the next time the app opens. Cookies ignore the port: a
 * preference set for 127.0.0.1 follows the page whatever port it is served from. The cost is
 * that cookies ride along on every request to the server, which is acceptable for a few dozen
 * bytes of furniture.
 */

const TEN_YEARS = 10 * 365 * 24 * 60 * 60;

export function getPref(key: string): string | null {
  const found = document.cookie.split("; ").find((c) => c.startsWith(`${key}=`));
  return found === undefined ? null : decodeURIComponent(found.slice(key.length + 1));
}

export function setPref(key: string, value: string): void {
  document.cookie = `${key}=${encodeURIComponent(value)}; max-age=${TEN_YEARS}; path=/; SameSite=Lax`;
}
