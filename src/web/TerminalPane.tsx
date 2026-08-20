import { useEffect, useRef } from "react";
import { WindowStrip } from "./WindowStrip.tsx";

/**
 * The change's terminal: a tmux session in the change directory, rendered by ttyd.
 *
 * The URL is fetched by the change view on arrival rather than here, so opening the tab does not
 * wait behind the dashboard's CLI calls for one of the browser's six connections.
 */
export function TerminalPane({
  changeId,
  url,
  error,
  visible,
}: {
  changeId: string;
  url: string | null;
  error: string | null;
  /** Whether the Terminals tab is the one in front; the strip only polls when it is. */
  visible: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);

  // Opening the tab should be enough to start typing.
  useEffect(() => {
    if (visible) frame.current?.contentWindow?.focus();
  }, [visible, url]);

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
      <WindowStrip
        changeId={changeId}
        active={visible}
        focusTerminal={() => frame.current?.contentWindow?.focus()}
      />
      <iframe ref={frame} src={url} title={`terminal for ${changeId}`} />
    </div>
  );
}
