/** The last segment of a path, split by hand so the package keeps no Node built-ins. */
export const baseName = (path: string): string =>
  path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
