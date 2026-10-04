import { type FormEvent, type JSX, useState } from "react";
import { apiClient } from "../../app-root/api.ts";

/**
 * The remote page's way in: the external listener refuses an unauthenticated `/api/*` request,
 * so a page without a device cookie shows this instead of the app. Redeeming a code here goes
 * through `/api/devices/pair`, which puts the token in an HttpOnly cookie — page JavaScript never
 * sees it — and then the page reloads into the app.
 */
export function PairingScreen({ onPaired }: { onPaired: () => void }): JSX.Element {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const trimmedName = name.trim();
      await apiClient.devices.pair({
        code: code.trim(),
        ...(trimmedName === "" ? {} : { name: trimmedName }),
      });
      onPaired();
    } catch (e) {
      // The server's message: "that pairing code is not valid", "…has expired", or the
      // rate-limit refusal. The transport carries it through as the error message.
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="page pairing">
      <header>
        <h2>Pair this device</h2>
      </header>
      <p className="hint">
        This Corvi server only accepts paired devices. On the machine that runs it, open Settings →
        Devices and create a pairing code, then enter it here.
      </p>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>Pairing code</span>
          <input
            aria-label="Pairing code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="A1B2C3D4E5F6A7B8"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <small>Short-lived and single-use.</small>
        </label>
        <label>
          <span>This device&apos;s name</span>
          <input
            aria-label="This device's name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Laptop"
          />
          <small>What the host will see in its device list.</small>
        </label>
        {error && <div className="error-banner">{error}</div>}
        <button className="create" type="submit" disabled={busy || code.trim() === ""}>
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
    </div>
  );
}
