import { useEffect, useRef } from "react";
import { isNewWindowKey, type Platform } from "./newWindowKey.ts";

/**
 * The change's terminal: a tmux session in the change directory, rendered by ttyd.
 *
 * There is nothing around it any more — which window you are in, and how to get to another, is
 * the navigation column's job. What is left here is the frame, the focus, and the new-window
 * chord.
 *
 * The URL is fetched by the app on arrival rather than here, so opening the page does not wait
 * behind the dashboard's CLI calls for one of the browser's six connections.
 */
export function TerminalPane({
  changeId,
  url,
  error,
  visible,
  platform,
  onNewWindow,
}: {
  changeId: string;
  url: string | null;
  error: string | null;
  /** Whether this is the page in front: what to focus, and when the new-window chord belongs
   * to us. */
  visible: boolean;
  /** The server's platform, which decides the chord: cmd-t on macOS, ctrl-alt-t on Linux (the
   * same test the injected shim applies, from web/newWindowKey.ts). */
  platform: Platform;
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

  // The new-window chord, from the page itself and from inside the terminal, which is where the
  // keyboard usually is; the frame cannot open a window, so it forwards the key as a message.
  useEffect(() => {
    if (!visible) return;
    const key = (e: KeyboardEvent) => {
      if (!isNewWindowKey(e, platform)) return;
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
  }, [visible, onNewWindow, platform]);

  if (error) {
    return (
      <div className="error-banner">
        {error}
        {error.includes("ENOENT") &&
          (platform === "mac"
            ? " — is ttyd installed? brew install ttyd"
            : " — is ttyd installed? (Arch: sudo pacman -S ttyd)")} (
        ttyd's own log: <code>/tmp/iwe-ttyd-{changeId}.log</code>)
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
