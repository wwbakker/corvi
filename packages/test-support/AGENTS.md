# @corvi/test-support

## Owns

The test temp base (short on macOS, `tmpdir()` elsewhere), the run token, and `testTempDir`.
Test-only: no product code imports it.

## Public entrypoints

- `@corvi/test-support/temp`: `testTempBase`, `testTempBaseFor`, `runToken`, `testTempDir`

## Verification

`bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run boundaries`, `bun run test`.
