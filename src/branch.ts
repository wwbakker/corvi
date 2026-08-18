/** Default branch name for a picked issue: `PROJ-123-short-summary`. A default, not a rule —
 * the form lets you edit it before the change is created. */
export function branchFor(key: string, summary: string): string {
  const slug = summary
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents so branch names stay ASCII
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${key}-${slug}`.slice(0, 60).replace(/-+$/, "");
}
