# A setting may be a secret

> **Kind:** decision · **Status:** accepted

## Context

The settings page reads and writes the config file, and it does so with the file itself as the
source of truth: `settingsView` hands the browser the parsed file *and* the object every module
reads, and a save sends that shape back, merged over what is on disk. That is what makes the file
hand-editable, documented, and the only copy.

It also means a value in that file is sent to the browser and posted back on every save. For
every setting Corvi had until the Jira token, that was fine. For a token it is not:

- the secret would be in the page's own response, in whatever the browser keeps of it, and in any
  screenshot of the settings page;
- a save that edited something else would post the token back, and a save that omitted it would
  delete it — the page cannot distinguish "unchanged" from "cleared" with a plain string;
- the file it lives in is written with the default permissions, which are the process umask's.

The alternative — no secret in the config at all, environment only — was the standing position
("Corvi stores no secrets"). It is also a real limitation: a token that can only come from the
environment cannot be set from the interface, cannot differ per site without a variable per site,
and cannot be changed by the person the settings page is for.

## Decision

**A declared setting may be `secret`, and the core guarantees three things about one.** The flag
is `secret?: boolean` on `ExtensionSetting` and `WorkspaceSetting`
(`src/domain/settings.ts`); the transformations are two pure functions in
`src/settings/server/secrets.ts` and nothing else looks inside.

1. **The page never receives it.** `settingsView` replaces a stored secret with a mask
   (`********`) in both `file` and `effective`, at both levels. It works on a copy: `effective` is
   the live config object every request is reading, and mutating it to hide a value would put the
   mask into the running program.
2. **A save that sends the mask back keeps what is stored.** The write path restores the stored
   value wherever the incoming one is the mask; an empty value clears the secret, a real value
   replaces it, and a mask for a field that holds nothing stores nothing — that last one is a
   page open before the secret existed, and writing the mask would make the mask the secret.
3. **The file is written for its owner alone** (`0600`). Nothing in `config.json` needs to be
   readable by anyone else, and a mode that depended on whether a token happened to be in it would
   flap.

The mask is opaque to the client: the field round-trips whatever string it was given, so the
browser half needs no knowledge of the masking and the contract stays two declarations and a
flag. A secret's environment variable is a **fallback rather than an override**, which is what
removes the need for the "set by X" lock the other settings have — the page is never showing a
value that the environment is silently beating.

## Consequences

- The core knows what a secret is; it still does not know what any extension's secret *means*.
  Which field is one is the extension's declaration, and the value is read by the extension from
  its own bag.
- An extension that declares one gets the whole treatment for free: masking, the keep-on-mask
  rule, and the file mode.
- Existing config files keep whatever mode they have until the next save. On the next save they
  are `0600`.
- `config.json` may now hold a secret, so the project no longer says it stores none. It says which
  one it can hold — a Jira token, if you choose to type it — and that the environment is always
  enough instead.
- A masked field shows as a password input. Clearing it and retyping it are the only two ways to
  change it, and neither is ambiguous.
