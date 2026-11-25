/**
 * A file dragged onto the page lands only where something takes it — the terminal. Anywhere else
 * a browser would navigate to it, and the app window hands that navigation to the system's opener
 * (apps/desktop/src/electron/main.ts), so a near miss opened the file in another program. This
 * cancels a file drop nothing took. A text drag is left alone: fields take text drops themselves.
 */
const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") ?? false;

/** Refuse the file drops no element took, for as long as the returned stop is not called. */
export const guardFileDrops = (target: Document): (() => void) => {
  const onDragOver = (event: DragEvent): void => {
    if (event.defaultPrevented || !carriesFiles(event)) return;
    // Cancelling dragover makes the drop arrive here instead of navigating; `none` keeps the
    // pointer saying it will not land.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  const onDrop = (event: DragEvent): void => {
    if (carriesFiles(event)) event.preventDefault();
  };
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
};
