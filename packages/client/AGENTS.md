# @corvi/client

## Owns

Named network operations for browser consumers: requests, canonical schema decoding, and
classified transport failures.

## Does not own

Backend implementation imports, application startup, caching or React state, or URL construction
by callers (`api<T>(path)`-style generics are not part of the API).

## Public entrypoints

- `@corvi/client`: `makeChangesClient`/`ChangesClient`, `makeWireClient`/`WireClient` (for
  extension-local DTOs), `directoryListingQuery`, `ClientError` (status and structured body)

## Dependencies

`@corvi/contracts` and `effect`. Browser-safe: no Node or native imports.

## Invariants

- Requests and responses are validated with the canonical contract schemas, so server and client
  cannot disagree silently.
- A failed request is a classified `ClientError` carrying the status; a network failure has no
  status and says the server was unreachable.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
