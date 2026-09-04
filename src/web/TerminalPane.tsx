import { useEffect, useRef } from "react";

/**
 * The change's terminal: a tmux session in the change directory, rendered by ttyd.
 *
 * There is nothing around it any more — which window you are in, and how to get to another, is
 * the navigation column's job. What is left here is the frame, the focus, and cmd-t.
 *
 * The URL is fetched by the app on arrival rather than here, so opening the page does not wait
 * behind the dashboard's CLI calls for one of the browser's six connections.
 */
export function TerminalPane({
  changeId,
  url,
  error,
  visible,
  onNewWindow,
}: {
  changeId: string;
  url: string | null;
  error: string | null;
  /** Whether this is the page in front: what to focus, and when cmd-t belongs to us. */
  visible: boolean;
  onNewWindow: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);

  // Opening it should be enough to start typing. Same-origin, so the terminal's own input can
  // be focused rather than just the frame around it.
  useEffect(() => {
    if (!visible) return;
    const inner = frame.current?.contentDocument;
    (inner?.querySelector("textarea") ?? frame.current?.contentWindow)?.focus();
  }, [visible, url]);

  // cmd-t, from the page itself and from inside the terminal, which is where the keyboard
  // usually is; the frame cannot open a window, so it forwards the key as a message.
  useEffect(() => {
    if (!visible) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "t" || !e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      onNewWindow();
    };
    const message = (e: MessageEvent) => {
      if (e.origin === location.origin && (e.data as { iwe?: string })?.iwe === "new-window")
        onNewWindow();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("message", message);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("message", message);
    };
  }, [visible, onNewWindow]);

  if (error) {
    return (
      <div className="error-banner">
        {error}
        {error.includes("ENOENT") && " — is ttyd installed? brew install ttyd"} (ttyd's own log:{" "}
        <code>/tmp/iwe-ttyd-{changeId}.log</code>)
      </div>
    );
  }
  if (!url) return <p className="hint">starting terminal…</p>;
  return (
    <div className="terminal">
      <iframe ref={frame} src={url} title={`terminal for ${changeId}`} />
    </div>
  );
}
