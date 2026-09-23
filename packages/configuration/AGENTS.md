# @corvi/configuration

## Owns

The configuration vocabulary and the settings precedence chain.

- `./config`: what a workspace is, what the resolved config holds, the config file's write
  shape, and the fallbacks (`DEFAULT_WORKSPACE`, `DEFAULT_IDEATION_PROMPT`). Pure.
- `./settings`: `resolveSetting` (bag → environment → file → fallback), the bag readers
  (`bagString`, `bagList`), and the override readers the settings page locks fields with.
  Environment variable *names* are the app's (`ENV_OVERRIDES`); this reads the names it is
  handed.

## Does not own

Reading and writing the config file, path defaults, migrations, the runtime snapshot, or
integration execution. The app's workspace server does the file I/O, builds `ENV_OVERRIDES`
from the product's identity, injects the workspace migrator, and refills the one snapshot the
runtime holds.

## Public entrypoints

- `@corvi/configuration/config`: `Workspace`, `Config`, `ConfigFile`, `DEFAULT_WORKSPACE`,
  `DEFAULT_IDEATION_PROMPT`
- `@corvi/configuration/settings`: `SettingBag`, `resolveSetting`, `bagString`, `bagList`,
  `envOverride`, `overriddenSettings`, `overriddenExtensionSettings`, `SettingDeclaration`,
  `SettingsHolder`

## Dependencies

`@corvi/contracts` (the default workspace value and the shared schema it is typed against).
`resolveSetting` reads `process.env` by name; no Node imports and nothing browser-unsafe.

## Verification

`bun run typecheck`, `bun run lint`, `bun run boundaries`, `bun run test`.
