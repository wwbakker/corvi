/** The last segment of a path, split by hand so the package keeps no Node built-ins: the
 * browser-safe half of the domain already does this the same way. */
export const baseName = (path: string): string =>
  path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
