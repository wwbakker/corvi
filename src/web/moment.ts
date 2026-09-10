/** Date and time of day: two changes made on one day are the normal case, and which came first
 * is the useful part. Local time, since that is when you were sitting there. */
export const moment = (iso: string): string => {
  const at = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
