/** How long ago, in the words the pages use: "just now", "12m ago", "3h ago", "2d ago".
 *
 * Shared rather than written twice: the Azure DevOps page bakes it into a line of its own ("2h
 * ago", "20260911.3 failed 2h ago") and a widget row shows it beside a build, and two answers to
 * one question drift. */
export const ago = (iso?: string | null): string => {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};
