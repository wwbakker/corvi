import { type JSX, useEffect, useRef } from "react";

import type { LargeUpload } from "./payload.ts";

/**
 * The question a large drop or paste asks before it is uploaded: what it is, how big, and where
 * the copy goes. Escape and "Don't upload" are the same answer, and nothing is sent until "Upload".
 */
export function LargeUploadDialog({
  upload,
  onAnswer,
}: {
  upload: LargeUpload;
  onAnswer: (proceed: boolean) => void;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="large-upload"
      onCancel={(event) => {
        event.preventDefault();
        onAnswer(false);
      }}
    >
      <h3>Upload {upload.what}?</h3>
      <p className="hint">
        That is {upload.size}. A copy goes to the change&apos;s <code>.attachments</code> folder on the
        machine the terminal runs on, and its path is pasted into the terminal.
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={() => onAnswer(false)}>
          Don&apos;t upload
        </button>
        <button type="button" className="primary" autoFocus onClick={() => onAnswer(true)}>
          Upload
        </button>
      </div>
    </dialog>
  );
}
