# @corvi/client

## Owns

Named network operations for browser consumers, by domain (`client.settings`, `client.devices`,
`client.tailscale`, `client.changes`, …): requests, canonical schema decoding, and classified
transport failures. The settings editor's pairing helper (`client.workspaces.pairRemote`) asks the
local server to redeem a code on a remote one; the server implements that route itself, and its
outbound exchange calls `devices.redeem` and `workspaces.list` through this same client rather
than hand-rolling a fetch.

## Does not own

Backend implementation imports, application startup, caching or React state, or URL construction
by callers (`api<T>(path)`-style generics are not part of the API).

## Public entrypoints

- `@corvi/client`: `makeCorviClient`/`CorviClient` with the domain namespaces, `makeWireClient`/
  `WireClient` (for extension-local DTOs), `directoryListingQuery`, `ClientError` (status and
  structured body)

## Dependencies

`@corvi/contracts` and `effect`. Browser-safe: no Node or native imports.

## Invariants

- Requests and responses are validated with the canonical contract schemas, so server and client
  cannot disagree silently.
- A failed request is a classified `ClientError` carrying the status; a network failure has no
  status and says the server was unreachable.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
